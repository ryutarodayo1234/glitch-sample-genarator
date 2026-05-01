const AudioContext = window.AudioContext || window.webkitAudioContext;
let ctx, masterGain, eqLow, eqMid, eqHigh, lofiFilter, distNode, reverbNode, dryGain, wetGain;
let recordedBuffer = null;
let sourceNode = null;
let isPlaying = false, isRecording = false;
let mediaRecorder, audioChunks = [];
let drawFrameId = null;
let glitchTimeoutId = null;
let currentOffset = 0;
let chunkStartTime = 0;
let recordStartTime = 0;
let recordWaveformPoints = [];
let glitchDecisions = [];
let selectionStart = 0;
let selectionEnd = 1.0;
let isSelecting = false;
const offscreenCanvas = document.createElement('canvas');
const offscreenCtx = offscreenCanvas.getContext('2d');

const btnRecord = document.getElementById('btn-record');
const btnPlay = document.getElementById('btn-play');
const btnSave = document.getElementById('btn-save');
const statusText = document.getElementById('status-text');
const canvas = document.getElementById('waveform');
const canvasCtx = canvas.getContext('2d');

const knobVals = {
    'knob-eq-low': 50, 'knob-pitch': 50, 'knob-eq-high': 50, 'knob-vol': 60,
    'knob-lofi': 40, 'knob-bpm': 41, 'knob-dist': 10, 'knob-reverb': 10
};

function initAudioFull() {
    if (ctx) return;
    ctx = new AudioContext();

    eqLow = ctx.createBiquadFilter(); eqLow.type = 'lowshelf'; eqLow.frequency.value = 320;
    eqHigh = ctx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3200;
    distNode = ctx.createWaveShaper();
    reverbNode = ctx.createConvolver();
    reverbNode.buffer = generateReverbImpulse(ctx);

    dryGain = ctx.createGain();
    wetGain = ctx.createGain();
    masterGain = ctx.createGain();

    eqLow.connect(eqHigh); eqHigh.connect(distNode);
    distNode.connect(dryGain); distNode.connect(reverbNode); reverbNode.connect(wetGain);
    dryGain.connect(masterGain); wetGain.connect(masterGain); masterGain.connect(ctx.destination);

    updateEffectParams();
}

function generateReverbImpulse(targetCtx) {
    const rate = targetCtx.sampleRate, length = rate * 2, impulse = targetCtx.createBuffer(2, length, rate);
    for (let i = 0; i < 2; i++) {
        const channel = impulse.getChannelData(i);
        for (let j = 0; j < length; j++) channel[j] = (Math.random() * 2 - 1) * Math.exp(-j / (rate * 0.5));
    }
    return impulse;
}

function makeDistortionCurve(amount) {
    const k = amount * 100, n = 44100, curve = new Float32Array(n), deg = Math.PI / 180;
    for (let i = 0; i < n; ++i) {
        const x = i * 2 / n - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

function updateEffectParams() {
    if (!ctx) return;
    eqLow.gain.value = ((knobVals['knob-eq-low'] - 50) / 50) * 12;
    eqHigh.gain.value = ((knobVals['knob-eq-high'] - 50) / 50) * 12;
    masterGain.gain.value = (knobVals['knob-vol'] / 100) * 1.5;

    const dist = knobVals['knob-dist'] / 100;
    distNode.curve = dist > 0.05 ? makeDistortionCurve(dist * 5) : null;

    const rev = knobVals['knob-reverb'] / 100;
    dryGain.gain.value = 1 - rev;
    wetGain.gain.value = rev;

    // Pitch & Loop update for current sourceNode if in normal loop
    if (sourceNode && !glitchTimeoutId && recordedBuffer) {
        const octaves = ((knobVals['knob-pitch'] - 50) / 50) * 3;
        sourceNode.playbackRate.value = Math.pow(2, octaves);
        const duration = recordedBuffer.duration;
        sourceNode.loopStart = selectionStart * duration;
        sourceNode.loopEnd = selectionEnd * duration;
    }
}

function updateBpmLabel(val) {
    const label = document.getElementById('label-bpm');
    if (!label) return;
    if (val < 5) label.textContent = 'BPM: OFF';
    else label.textContent = `BPM: ${Math.round(20 + (val / 100) * 280)}`;
}

document.querySelectorAll('.knob').forEach(knob => {
    setKnobVisual(knob, knobVals[knob.id]);
    if (knob.id === 'knob-bpm') updateBpmLabel(knobVals[knob.id]);
    let startY = 0, startVal = 0;
    const onStart = (e) => {
        startY = e.touches ? e.touches[0].clientY : e.clientY;
        startVal = knobVals[knob.id];
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false }); document.addEventListener('touchend', onEnd);
    };
    const onMove = (e) => {
        if (e.cancelable) e.preventDefault();
        const y = e.touches ? e.touches[0].clientY : e.clientY;
        const prevBpm = knobVals['knob-bpm'];
        knobVals[knob.id] = Math.max(0, Math.min(100, startVal + (startY - y)));
        setKnobVisual(knob, knobVals[knob.id]);
        updateEffectParams();
        if (knob.id === 'knob-bpm') {
            updateBpmLabel(knobVals[knob.id]);
            if (isPlaying && prevBpm < 5 && knobVals[knob.id] >= 5) {
                if (sourceNode) { sourceNode.stop(); sourceNode.disconnect(); sourceNode = null; }
                startGlitchLoop();
            }
        }
    };
    const onEnd = () => {
        document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onEnd);
    };
    knob.addEventListener('mousedown', onStart);
    knob.addEventListener('touchstart', onStart, { passive: false });
});

function setKnobVisual(knob, val) {
    knob.style.transform = `rotate(${(val / 100) * 270 - 135}deg)`;
}

function generateGlitchDecisions() {
    glitchDecisions = [];
    for (let i = 0; i < 1000; i++) {
        glitchDecisions.push({
            jump: Math.random(),
            offset: Math.random(),
            rest: Math.random(),
            restLen: Math.random()
        });
    }
}

function updateOffscreenWaveform(buffer) {
    offscreenCanvas.width = canvas.parentElement.clientWidth;
    offscreenCanvas.height = canvas.parentElement.clientHeight - 20;
    const w = offscreenCanvas.width, h = offscreenCanvas.height;
    offscreenCtx.clearRect(0, 0, w, h);
    if (!buffer) return;

    const data = buffer.getChannelData(0), step = Math.ceil(data.length / w), amp = h / 2;
    offscreenCtx.fillStyle = '#b3e6b3';

    for (let i = 0; i < w; i++) {
        let min = 1.0, max = -1.0;
        for (let j = 0; j < step; j++) {
            const datum = data[(i * step) + j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }
        offscreenCtx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }
}

function drawWaveformWithPosition(posTime = -1) {
    canvas.width = offscreenCanvas.width || canvas.parentElement.clientWidth;
    canvas.height = offscreenCanvas.height || (canvas.parentElement.clientHeight - 20);
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    if (offscreenCanvas.width > 0) {
        canvasCtx.drawImage(offscreenCanvas, 0, 0);
    }

    // 選択範囲のハイライト表示（範囲外を暗くし、選択範囲を明るく強調）
    if (recordedBuffer && (selectionStart > 0 || selectionEnd < 1)) {
        const xStart = selectionStart * canvas.width;
        const xEnd = selectionEnd * canvas.width;
        const xWidth = xEnd - xStart;

        // 範囲外（左）
        canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        canvasCtx.fillRect(0, 0, xStart, canvas.height);
        // 範囲外（右）
        canvasCtx.fillRect(xEnd, 0, canvas.width - xEnd, canvas.height);

        // 選択範囲に薄い光彩を追加
        canvasCtx.fillStyle = 'rgba(179, 230, 179, 0.1)';
        canvasCtx.fillRect(xStart, 0, xWidth, canvas.height);

        // 選択範囲の境界線（白に近い色でクッキリと）
        canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        canvasCtx.lineWidth = 1.5;
        canvasCtx.beginPath();
        canvasCtx.moveTo(xStart, 0); canvasCtx.lineTo(xStart, canvas.height);
        canvasCtx.moveTo(xEnd, 0); canvasCtx.lineTo(xEnd, canvas.height);
        canvasCtx.stroke();
    }

    if (posTime >= 0 && recordedBuffer) {
        const x = (posTime / recordedBuffer.duration) * canvas.width;
        canvasCtx.strokeStyle = 'rgba(217, 83, 79, 0.9)';
        canvasCtx.lineWidth = 2;
        canvasCtx.beginPath();
        canvasCtx.moveTo(x, 0);
        canvasCtx.lineTo(x, canvas.height);
        canvasCtx.stroke();
    }
}

let selectStartX = 0;
function startSelection(e) {
    if (!recordedBuffer) return;
    isSelecting = true;
    const rect = canvas.getBoundingClientRect();
    selectStartX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    selectionStart = selectStartX;
    selectionEnd = selectStartX;
    drawWaveformWithPosition(-1);
}
function moveSelection(e) {
    if (!isSelecting) return;
    const rect = canvas.getBoundingClientRect();
    let currentX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    selectionStart = Math.min(selectStartX, currentX);
    selectionEnd = Math.max(selectStartX, currentX);
    drawWaveformWithPosition(-1);
}
function endSelection() {
    if (!isSelecting) return;
    isSelecting = false;
    if (Math.abs(selectionEnd - selectionStart) < 0.01) {
        selectionStart = 0; selectionEnd = 1.0;
    }
    drawWaveformWithPosition(-1);
}
canvas.addEventListener('mousedown', startSelection);
document.addEventListener('mousemove', (e) => { if (isSelecting) moveSelection(e); });
document.addEventListener('mouseup', endSelection);

canvas.addEventListener('touchstart', (e) => {
    if (e.cancelable) e.preventDefault();
    startSelection(e.touches[0]);
}, { passive: false });
document.addEventListener('touchmove', (e) => {
    if (isSelecting) {
        if (e.cancelable) e.preventDefault();
        moveSelection(e.touches[0]);
    }
}, { passive: false });
document.addEventListener('touchend', (e) => {
    if (isSelecting) endSelection();
}, { passive: false });

btnRecord.addEventListener('click', async () => {
    initAudioFull();
    if (ctx.state === 'suspended') ctx.resume();

    if (isRecording) {
        mediaRecorder.stop();
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        const micSource = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        micSource.connect(analyser);
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        function drawRealtime() {
            if (!isRecording) return;
            drawFrameId = requestAnimationFrame(drawRealtime);
            analyser.getByteTimeDomainData(dataArray);

            canvas.width = canvas.parentElement.clientWidth;
            canvas.height = canvas.parentElement.clientHeight - 20;
            const w = canvas.width, h = canvas.height;
            canvasCtx.clearRect(0, 0, w, h);

            // 現在の瞬間の最小・最大振幅を取得
            let min = 1.0, max = -1.0;
            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0 - 1.0;
                if (v < min) min = v;
                if (v > max) max = v;
            }

            // 進捗に合わせて描画ポイントを保存
            const elapsed = ctx.currentTime - recordStartTime;
            const progress = Math.min(1, elapsed / 6);
            const currentIdx = Math.floor(progress * w);

            if (!recordWaveformPoints[currentIdx]) {
                recordWaveformPoints[currentIdx] = { min: 1, max: -1 };
            }
            if (min < recordWaveformPoints[currentIdx].min) recordWaveformPoints[currentIdx].min = min;
            if (max > recordWaveformPoints[currentIdx].max) recordWaveformPoints[currentIdx].max = max;

            // 蓄積された波形を描画
            const amp = h / 2;
            canvasCtx.fillStyle = '#b3e6b3';
            for (let i = 0; i < recordWaveformPoints.length; i++) {
                const pt = recordWaveformPoints[i];
                if (pt) {
                    canvasCtx.fillRect(i, (1 + pt.min) * amp, 1, Math.max(1, (pt.max - pt.min) * amp));
                }
            }

            // 進捗バー（赤い線）
            const progressX = progress * w;
            canvasCtx.strokeStyle = 'rgba(217, 83, 79, 0.9)';
            canvasCtx.lineWidth = 3;
            canvasCtx.beginPath();
            canvasCtx.moveTo(progressX, 0);
            canvasCtx.lineTo(progressX, h);
            canvasCtx.stroke();
        }
        recordWaveformPoints = [];
        recordStartTime = ctx.currentTime;
        drawRealtime();

        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            isRecording = false;
            btnRecord.textContent = 'REC';
            btnRecord.classList.remove('active-rec');
            statusText.textContent = 'PROCESSING...';

            stream.getTracks().forEach(t => t.stop());
            if (drawFrameId) cancelAnimationFrame(drawFrameId);
            const arrayBuffer = await (new Blob(audioChunks)).arrayBuffer();
            ctx.decodeAudioData(arrayBuffer, (buf) => {
                recordedBuffer = buf;
                updateOffscreenWaveform(buf);
                drawWaveformWithPosition(-1);
                statusText.textContent = 'READY TO PLAY';
                generateGlitchDecisions();
                btnPlay.disabled = false; btnSave.disabled = false;
            });
        };
        mediaRecorder.start(); isRecording = true;
        btnRecord.textContent = 'STOP REC'; btnRecord.classList.add('active-rec');
        statusText.textContent = 'RECORDING...';
        setTimeout(() => { if (isRecording) mediaRecorder.stop(); }, 6000); // 6s limit
    } catch (err) { alert('マイクのアクセスが拒否されました。'); }
});

function loopPlaybackPosition() {
    if (!isPlaying) return;
    drawFrameId = requestAnimationFrame(loopPlaybackPosition);
    if (!recordedBuffer) return;

    const bpmVal = knobVals['knob-bpm'];
    let posTime = 0;
    const duration = recordedBuffer.duration;

    if (bpmVal < 5) {
        posTime = (ctx.currentTime - chunkStartTime) % duration;
    } else {
        const elapsed = ctx.currentTime - chunkStartTime;
        posTime = currentOffset + elapsed;
        if (posTime > duration) posTime -= duration;
    }
    drawWaveformWithPosition(posTime);
}

function stopPlayback() {
    isPlaying = false;
    if (drawFrameId) cancelAnimationFrame(drawFrameId);
    drawWaveformWithPosition(-1);
    if (sourceNode) { sourceNode.stop(); sourceNode.disconnect(); sourceNode = null; }
    if (glitchTimeoutId) { clearTimeout(glitchTimeoutId); glitchTimeoutId = null; }
}

function startPlayback() {
    isPlaying = true;
    loopPlaybackPosition();
    const bpmVal = knobVals['knob-bpm'];
    if (bpmVal < 5) playNormalLoop();
    else startGlitchLoop();
}

function playNormalLoop() {
    if (sourceNode) { sourceNode.stop(); sourceNode.disconnect(); }
    sourceNode = ctx.createBufferSource();
    sourceNode.buffer = recordedBuffer;
    sourceNode.connect(eqLow);
    sourceNode.loop = true;
    const duration = recordedBuffer.duration;
    sourceNode.loopStart = selectionStart * duration;
    sourceNode.loopEnd = selectionEnd * duration;

    const octaves = ((knobVals['knob-pitch'] - 50) / 50) * 3;
    sourceNode.playbackRate.value = Math.pow(2, octaves);

    chunkStartTime = ctx.currentTime;
    sourceNode.start(0, sourceNode.loopStart);
}

function startGlitchLoop() {
    const duration = recordedBuffer.duration;
    currentOffset = selectionStart * duration;
    let chunkIndex = 0;
    let lastOffset = -1;

    const schedule = () => {
        if (!isPlaying) return;

        const start = selectionStart * duration;
        const end = selectionEnd * duration;
        const range = Math.max(0.01, end - start);

        if (currentOffset < start || currentOffset >= end) currentOffset = start;

        const bpmVal = knobVals['knob-bpm'];
        if (bpmVal < 5) { playNormalLoop(); return; }

        const octaves = ((knobVals['knob-pitch'] - 50) / 50) * 3;
        const pRate = Math.pow(2, octaves);
        const actualBpm = 20 + (bpmVal / 100) * 280;
        const chunkLen = 15 / actualBpm;
        const bufChunkLen = chunkLen * pRate;

        const restProb = knobVals['knob-lofi'] / 100;
        const decision = glitchDecisions[chunkIndex % glitchDecisions.length];
        const now = ctx.currentTime;
        let waitTime = chunkLen;

        if (decision.rest > restProb) {
            const src = ctx.createBufferSource(); src.buffer = recordedBuffer;
            src.playbackRate.value = pRate;
            const envGain = ctx.createGain();
            envGain.connect(eqLow);
            envGain.gain.setValueAtTime(0, now);
            envGain.gain.linearRampToValueAtTime(1, now + 0.005);
            envGain.gain.setValueAtTime(1, now + 0.005);
            const decayEnd = now + Math.max(0.05, chunkLen * 0.8);
            envGain.gain.exponentialRampToValueAtTime(0.001, decayEnd);
            src.connect(envGain);

            if (decision.jump > 0.5) {
                currentOffset = start + decision.offset * Math.max(0, range - bufChunkLen);
            } else {
                currentOffset = start + ((currentOffset - start + bufChunkLen) % range);
            }
            lastOffset = currentOffset;
            chunkStartTime = now;
            src.start(now, currentOffset, Math.min(bufChunkLen, end - currentOffset));
        } else {
            const maxRest = Math.floor(restProb * 8) + 1;
            const restChunks = Math.floor(decision.restLen * maxRest) + 1;
            waitTime = chunkLen * restChunks;

            if (decision.jump < 0.5 && lastOffset !== -1) {
                const src = ctx.createBufferSource(); src.buffer = recordedBuffer;
                src.playbackRate.value = pRate;
                const envGain = ctx.createGain();
                envGain.connect(eqLow);
                envGain.gain.setValueAtTime(0, now);
                envGain.gain.linearRampToValueAtTime(1, now + 0.01);
                envGain.gain.exponentialRampToValueAtTime(0.001, now + waitTime);
                src.connect(envGain);
                src.start(now, lastOffset, Math.min(bufChunkLen * restChunks, end - lastOffset));
            }

            currentOffset = start + ((currentOffset - start + bufChunkLen * restChunks) % range);
            chunkStartTime = now;
        }
        chunkIndex++;
        glitchTimeoutId = setTimeout(schedule, waitTime * 1000);
    };
    schedule();
}

btnPlay.addEventListener('click', () => {
    if (isPlaying) {
        stopPlayback();
        btnPlay.textContent = 'PLAY'; statusText.textContent = 'STOPPED';
        btnPlay.classList.remove('btn-red');
        btnPlay.classList.add('btn-green');
    } else {
        generateGlitchDecisions();
        startPlayback();
        btnPlay.textContent = 'STOP'; statusText.textContent = 'PLAYING...';
        btnPlay.classList.remove('btn-green');
        btnPlay.classList.add('btn-red');
    }
});

btnSave.addEventListener('click', async () => {
    if (!recordedBuffer) return;
    statusText.textContent = 'RENDERING WAV...';

    const bpmVal = knobVals['knob-bpm'];
    const octaves = ((knobVals['knob-pitch'] - 50) / 50) * 3;
    const pRate = Math.pow(2, octaves);

    let renderDuration = recordedBuffer.duration;
    if (bpmVal >= 5) {
        const actualBpm = 20 + (bpmVal / 100) * 280;
        renderDuration = (60 / actualBpm) * 64; // 16小節分
    }

    const oCtx = new OfflineAudioContext(2, 96000 * renderDuration, 96000);

    const oEqLow = oCtx.createBiquadFilter(); oEqLow.type = 'lowshelf'; oEqLow.frequency.value = 320;
    const oEqHigh = oCtx.createBiquadFilter(); oEqHigh.type = 'highshelf'; oEqHigh.frequency.value = 3200;
    const oDist = oCtx.createWaveShaper();
    const oRev = oCtx.createConvolver(); oRev.buffer = generateReverbImpulse(oCtx);

    const oDry = oCtx.createGain(), oWet = oCtx.createGain(), oMaster = oCtx.createGain();

    oEqLow.gain.value = ((knobVals['knob-eq-low'] - 50) / 50) * 12;
    oEqHigh.gain.value = ((knobVals['knob-eq-high'] - 50) / 50) * 12;
    oMaster.gain.value = (knobVals['knob-vol'] / 100) * 1.5;

    const dist = knobVals['knob-dist'] / 100;
    if (dist > 0.05) oDist.curve = makeDistortionCurve(dist * 5);

    const rev = knobVals['knob-reverb'] / 100;
    oDry.gain.value = 1 - rev; oWet.gain.value = rev;

    oEqLow.connect(oEqHigh); oEqHigh.connect(oDist);
    oDist.connect(oDry); oDist.connect(oRev); oRev.connect(oWet);
    oDry.connect(oMaster); oWet.connect(oMaster); oMaster.connect(oCtx.destination);

    if (bpmVal < 5) {
        const oSrc = oCtx.createBufferSource(); oSrc.buffer = recordedBuffer;
        oSrc.connect(oEqLow);
        oSrc.loop = true;
        oSrc.loopStart = selectionStart * recordedBuffer.duration;
        oSrc.loopEnd = selectionEnd * recordedBuffer.duration;
        oSrc.playbackRate.value = pRate;
        oSrc.start(0, oSrc.loopStart);
    } else {
        const actualBpm = 20 + (bpmVal / 100) * 280;
        const chunkLen = 15 / actualBpm;
        const bufChunkLen = chunkLen * pRate;
        const start = selectionStart * recordedBuffer.duration;
        const end = selectionEnd * recordedBuffer.duration;
        const range = Math.max(0.01, end - start);
        let offset = start, t = 0, cIdx = 0, lOffset = -1;
        while (t < renderDuration) {
            const restProb = knobVals['knob-lofi'] / 100;
            const decision = glitchDecisions[cIdx % glitchDecisions.length];

            if (decision.rest > restProb) {
                const sn = oCtx.createBufferSource(); sn.buffer = recordedBuffer;
                sn.playbackRate.value = pRate;
                const envGain = oCtx.createGain();
                envGain.connect(oEqLow);
                envGain.gain.setValueAtTime(0, t);
                envGain.gain.linearRampToValueAtTime(1, t + 0.005);
                envGain.gain.setValueAtTime(1, t + 0.005);
                const decayEnd = t + Math.max(0.05, chunkLen * 0.8);
                envGain.gain.exponentialRampToValueAtTime(0.001, decayEnd);
                sn.connect(envGain);
                if (decision.jump > 0.5) {
                    offset = start + decision.offset * Math.max(0, range - bufChunkLen);
                } else {
                    offset = start + ((offset - start + bufChunkLen) % range);
                }
                lOffset = offset;
                sn.start(t, offset, Math.min(bufChunkLen, end - offset));
                t += chunkLen;
            } else {
                const maxRest = Math.floor(restProb * 8) + 1;
                const restChunks = Math.floor(decision.restLen * maxRest) + 1;
                const wait = chunkLen * restChunks;
                if (decision.jump < 0.5 && lOffset !== -1) {
                    const sn = oCtx.createBufferSource(); sn.buffer = recordedBuffer;
                    sn.playbackRate.value = pRate;
                    const envGain = oCtx.createGain();
                    envGain.connect(oEqLow);
                    envGain.gain.setValueAtTime(0, t);
                    envGain.gain.linearRampToValueAtTime(1, t + 0.01);
                    envGain.gain.exponentialRampToValueAtTime(0.001, t + wait);
                    sn.connect(envGain);
                    sn.start(t, lOffset, Math.min(bufChunkLen * restChunks, end - lOffset));
                }
                offset = start + ((offset - start + bufChunkLen * restChunks) % range);
                t += wait;
            }
            cIdx++;
        }
    }

    const rendered = await oCtx.startRendering();
    const url = URL.createObjectURL(bufferToWave(rendered, rendered.length));

    const a = document.createElement('a');
    a.style.display = 'none'; a.href = url; a.download = `glitch_${Date.now()}.wav`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    statusText.textContent = 'SAVED!';
});

function bufferToWave(abuffer, len) {
    const numOfChan = abuffer.numberOfChannels, length = len * numOfChan * 4 + 44;
    const buffer = new ArrayBuffer(length), view = new DataView(buffer), channels = [];
    let offset = 0, pos = 0;
    function setUint16(d) { view.setUint16(pos, d, true); pos += 2; }
    function setUint32(d) { view.setUint32(pos, d, true); pos += 4; }
    setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
    setUint32(0x20746d66); setUint32(16); setUint16(3); setUint16(numOfChan);
    setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 4 * numOfChan);
    setUint16(numOfChan * 4); setUint16(32);
    setUint32(0x61746164); setUint32(length - pos - 4);
    for (let i = 0; i < abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i));
    while (pos < length) {
        for (let i = 0; i < numOfChan; i++) {
            view.setFloat32(pos, channels[i][offset], true); pos += 4;
        }
        offset++;
    }
    return new Blob([buffer], { type: "audio/wav" });
}
