import * as THREE from 'three';

// --- 全局配置与状态 ---
const CONFIG = {
    // 物理参数
    gridWidth: 20,       // 物理网格横向节点数
    gridHeight: 15,      // 物理网格纵向节点数
    clothWidth: 16,      // 物理网格 3D 世界宽度
    clothHeight: 12,     // 物理网格 3D 世界高度
    physicsIterations: 6, // 约束求解器迭代次数
    gravity: -0.04,       // 微弱重力
    damping: 0.93,        // 物理阻尼
    
    // 5层材质的层级属性 (1:最表层 -> 5:最深壁垒)
    layers: [
        { z: 1.6, restoring: 0.12, tear: 1.30 }, // L1: 现实层 (偏脆硬)
        { z: 1.2, restoring: 0.10, tear: 1.40 }, // L2: 裂缝层
        { z: 0.8, restoring: 0.08, tear: 1.50 }, // L3: 血肉层
        { z: 0.4, restoring: 0.07, tear: 1.65 }, // L4: 发光层
        { z: 0.0, restoring: 0.06, tear: 1.80 }  // L5: 深渊层 (粘稠，拉伸度极大)
    ],
    // L6 背景层 Z 轴深度
    bgZ: -5.0
};

// 交互指针状态管理 (支持鼠标/触控以及双手的多点并发拖拽)
const state = {
    audioEnabled: false,
    audioInitialized: false,
    gestureEnabled: false,
    gestureInitialized: false,
    loadingComplete: false,
    isResetting: false,
    
    // 多点指针对象
    pointers: {
        mouse: { active: false, ndc: new THREE.Vector2(), draggedParticle: null, targetDragPos: new THREE.Vector3(), activeClothIndex: null },
        leftHand: { active: false, ndc: new THREE.Vector2(), draggedParticle: null, targetDragPos: new THREE.Vector3(), activeClothIndex: null },
        rightHand: { active: false, ndc: new THREE.Vector2(), draggedParticle: null, targetDragPos: new THREE.Vector3(), activeClothIndex: null }
    }
};

// --- Web Audio API 氛围音效系统 ---
class SoundSystem {
    constructor() {
        this.ctx = null;
        this.masterVolume = null;
        this.synthLoopId = null;
        this.tensionOsc = null;
        this.tensionGain = null;
        this.tensionFilter = null;
        this.notes = [130.81, 155.56, 196.00, 233.08, 261.63, 233.08, 196.00, 155.56];
        this.currentNoteIndex = 0;
    }

    init() {
        if (this.ctx) return;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
        
        this.masterVolume = this.ctx.createGain();
        this.masterVolume.gain.setValueAtTime(0.0, this.ctx.currentTime);
        this.masterVolume.connect(this.ctx.destination);

        this.setupTensionSound();
        this.startBGM();

        state.audioInitialized = true;
    }

    setVolume(volume) {
        if (!this.masterVolume) return;
        this.masterVolume.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + 0.5);
    }

    setupTensionSound() {
        this.tensionOsc = this.ctx.createOscillator();
        this.tensionOsc.type = 'sawtooth';
        this.tensionOsc.frequency.setValueAtTime(45, this.ctx.currentTime);

        this.tensionFilter = this.ctx.createBiquadFilter();
        this.tensionFilter.type = 'lowpass';
        this.tensionFilter.frequency.setValueAtTime(80, this.ctx.currentTime);
        this.tensionFilter.Q.setValueAtTime(4, this.ctx.currentTime);

        this.tensionGain = this.ctx.createGain();
        this.tensionGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

        this.tensionOsc.connect(this.tensionFilter);
        this.tensionFilter.connect(this.tensionGain);
        this.tensionGain.connect(this.masterVolume);
        this.tensionOsc.start();
    }

    updateTension(speed, stretchRatio) {
        if (!this.ctx || !this.tensionOsc) return;
        const targetFreq = 42 + stretchRatio * 22 + speed * 12;
        const filterFreq = 65 + stretchRatio * 140 + speed * 90;
        const volume = Math.min(0.25, stretchRatio * 0.15 + speed * 0.08);

        this.tensionOsc.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.05);
        this.tensionFilter.frequency.setTargetAtTime(filterFreq, this.ctx.currentTime, 0.05);
        this.tensionGain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.1);
    }

    stopTension() {
        if (!this.tensionGain) return;
        this.tensionGain.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.15);
    }

    playRipSound() {
        if (!this.ctx) return;
        const bufferSize = this.ctx.sampleRate * 0.18;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noiseNode = this.ctx.createBufferSource();
        noiseNode.buffer = buffer;

        const noiseFilter = this.ctx.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.setValueAtTime(350, this.ctx.currentTime);
        noiseFilter.frequency.exponentialRampToValueAtTime(80, this.ctx.currentTime + 0.18);
        noiseFilter.Q.setValueAtTime(3, this.ctx.currentTime);

        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.14, this.ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.18);

        noiseNode.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.masterVolume);
        noiseNode.start();
    }

    startBGM() {
        const playSynth = () => {
            const time = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            osc.type = 'triangle';
            const baseFreq = this.notes[this.currentNoteIndex];
            osc.frequency.setValueAtTime(baseFreq * 0.5, time);
            
            const lp = this.ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.setValueAtTime(140, time);
            lp.frequency.exponentialRampToValueAtTime(75, time + 0.35);
            
            const envelope = this.ctx.createGain();
            envelope.gain.setValueAtTime(0.0, time);
            envelope.gain.linearRampToValueAtTime(0.38, time + 0.05);
            envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.48);
            
            const delay = this.ctx.createDelay();
            delay.delayTime.setValueAtTime(0.2, time);
            const feedback = this.ctx.createGain();
            feedback.gain.setValueAtTime(0.32, time);

            osc.connect(lp);
            lp.connect(envelope);
            envelope.connect(this.masterVolume);
            
            envelope.connect(delay);
            delay.connect(feedback);
            feedback.connect(delay);
            feedback.connect(this.masterVolume);

            osc.start(time);
            osc.stop(time + 0.55);

            this.currentNoteIndex = (this.currentNoteIndex + 1) % this.notes.length;
        };

        const scheduleNext = () => {
            playSynth();
            this.synthLoopId = setTimeout(scheduleNext, 280);
        };
        scheduleNext();
    }
}

const sounds = new SoundSystem();

// --- 物理系统类 ---

class Particle {
    constructor(x, y, z, u, v) {
        this.position = new THREE.Vector3(x, y, z);
        this.previous = new THREE.Vector3(x, y, z);
        this.original = new THREE.Vector3(x, y, z);
        this.uv = new THREE.Vector2(u, v);
        this.pinned = false;
        this.pinPosition = new THREE.Vector3();
    }

    update(dt, damping, gravity, restoringStiffness) {
        if (this.pinned) {
            this.position.copy(this.pinPosition);
            this.previous.copy(this.position);
            return;
        }

        const force = new THREE.Vector3()
            .subVectors(this.original, this.position)
            .multiplyScalar(restoringStiffness);
        force.y += gravity;

        const temp = this.position.clone();
        
        this.position.x += (this.position.x - this.previous.x) * damping + force.x * dt * dt;
        this.position.y += (this.position.y - this.previous.y) * damping + force.y * dt * dt;
        this.position.z += (this.position.z - this.previous.z) * damping + force.z * dt * dt;
        
        this.previous.copy(temp);
    }
}

class Constraint {
    constructor(p1, p2, tearLimit) {
        this.p1 = p1;
        this.p2 = p2;
        this.restLength = p1.position.distanceTo(p2.position);
        this.tearLimit = tearLimit;
        this.broken = false;
        this.drawn = false;
    }

    resolve() {
        if (this.broken) return;

        const diff = new THREE.Vector3().subVectors(this.p2.position, this.p1.position);
        const currentLength = diff.length();
        
        if (currentLength === 0) return;

        if (currentLength > this.restLength * this.tearLimit) {
            this.broken = true;
            return;
        }

        const ratio = (this.restLength - currentLength) / currentLength * 0.5;
        const offset = diff.multiplyScalar(ratio);

        if (!this.p1.pinned) this.p1.position.sub(offset);
        if (!this.p2.pinned) this.p2.position.add(offset);
    }
}

class Cloth {
    constructor(width, height, segmentsW, segmentsH, tearLimit, restoringStiffness) {
        this.particles = [];
        this.constraints = [];
        this.tearLimit = tearLimit;
        this.restoringStiffness = restoringStiffness;
        
        for (let j = 0; j <= segmentsH; j++) {
            const y = height / 2 - (j / segmentsH) * height;
            const v = 1.0 - (j / segmentsH);
            for (let i = 0; i <= segmentsW; i++) {
                const x = (i / segmentsW) * width - width / 2;
                const u = i / segmentsW;
                
                const p = new Particle(x, y, 0, u, v);
                if (i === 0 || i === segmentsW || j === 0 || j === segmentsH) {
                    p.pinned = true;
                    p.pinPosition.copy(p.position);
                }
                this.particles.push(p);
            }
        }

        const getIndex = (i, j) => j * (segmentsW + 1) + i;

        for (let j = 0; j <= segmentsH; j++) {
            for (let i = 0; i <= segmentsW; i++) {
                if (i < segmentsW) {
                    this.constraints.push(new Constraint(this.particles[getIndex(i, j)], this.particles[getIndex(i + 1, j)], this.tearLimit));
                }
                if (j < segmentsH) {
                    this.constraints.push(new Constraint(this.particles[getIndex(i, j)], this.particles[getIndex(i, j + 1)], this.tearLimit));
                }
                if (i < segmentsW && j < segmentsH) {
                    this.constraints.push(new Constraint(this.particles[getIndex(i, j)], this.particles[getIndex(i + 1, j + 1)], this.tearLimit));
                    this.constraints.push(new Constraint(this.particles[getIndex(i + 1, j)], this.particles[getIndex(i, j + 1)], this.tearLimit));
                }
                if (i < segmentsW - 1) {
                    this.constraints.push(new Constraint(this.particles[getIndex(i, j)], this.particles[getIndex(i + 2, j)], this.tearLimit * 1.15));
                }
                if (j < segmentsH - 1) {
                    this.constraints.push(new Constraint(this.particles[getIndex(i, j)], this.particles[getIndex(i, j + 2)], this.tearLimit * 1.15));
                }
            }
        }
    }

    update(dt) {
        for (let i = 0; i < this.particles.length; i++) {
            this.particles[i].update(dt, CONFIG.damping, CONFIG.gravity, this.restoringStiffness);
        }

        let newlyBroken = false;
        for (let iter = 0; iter < CONFIG.physicsIterations; iter++) {
            for (let i = 0; i < this.constraints.length; i++) {
                const c = this.constraints[i];
                if (c.broken) continue;
                c.resolve();
                if (c.broken) newlyBroken = true;
            }
        }
        return newlyBroken;
    }

    reset() {
        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            p.position.copy(p.original);
            p.previous.copy(p.original);
            p.pinned = false;
            
            const segmentsW = CONFIG.gridWidth;
            const segmentsH = CONFIG.gridHeight;
            const j = Math.floor(i / (segmentsW + 1));
            const x_idx = i % (segmentsW + 1);
            if (x_idx === 0 || x_idx === segmentsW || j === 0 || j === segmentsH) {
                p.pinned = true;
                p.pinPosition.copy(p.position);
            }
        }
        for (let i = 0; i < this.constraints.length; i++) {
            this.constraints[i].broken = false;
            this.constraints[i].drawn = false;
        }
    }
}

// --- App 主类 ---

class App {
    constructor() {
        this.container = document.getElementById('canvas-container');
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.raycaster = new THREE.Raycaster();
        this.raycaster.params.Mesh = { threshold: 0.1 };

        // MediaPipe 与 Webcam 相关
        this.videoElement = document.getElementById('webcam');
        this.webcamCanvas = document.getElementById('webcam-canvas');
        this.webcamCtx = this.webcamCanvas.getContext('2d');
        this.mpHands = null;
        this.mpCamera = null;

        // 5 层物理布料
        this.cloths = [];
        // 6 层 Mesh (5个变形网格，1个背景)
        this.meshes = [];

        // 6 组离屏 Canvas (内容贴图和撕裂遮罩)
        this.contentCanvases = [];
        this.contentCtxs = [];
        this.contentTextures = [];

        this.maskCanvases = [];
        this.maskCtxs = [];
        this.maskTextures = [];

        // 灰烬粒子系统
        this.sporeSystem = null;
        this.sporeCount = 250;
        
        // 视差倾斜
        this.targetRotation = new THREE.Vector2(0, 0);

        this.init();
    }

    init() {
        this.setupThree();
        this.setupLights();
        this.setupBackgroundParticles();
        this.setupCanvases();
        this.drawDefaultLayers();
        this.setupMeshes();
        this.setupEvents();
        this.setupUI();

        // 渐隐 loading
        const overlay = document.getElementById('loading-overlay');
        const progressBar = document.getElementById('loading-bar');
        const percentText = document.getElementById('loading-percent');
        
        progressBar.style.width = '100%';
        percentText.innerText = '100%';
        
        setTimeout(() => {
            overlay.classList.add('fade-out');
            state.loadingComplete = true;
            this.clock = new THREE.Clock();
            this.animate();
        }, 600);
    }

    setupThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x040102);
        this.scene.fog = new THREE.FogExp2(0x0b0305, 0.06);

        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
        this.camera.position.set(0, 0, 15);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        this.container.appendChild(this.renderer.domElement);
    }

    setupLights() {
        const ambient = new THREE.AmbientLight(0xffffff, 0.45);
        this.scene.add(ambient);

        const dirLight1 = new THREE.DirectionalLight(0xff3333, 2.5);
        dirLight1.position.set(6, 6, 4);
        this.scene.add(dirLight1);

        const dirLight2 = new THREE.DirectionalLight(0x3366ff, 1.2);
        dirLight2.position.set(-6, -6, 2);
        this.scene.add(dirLight2);
    }

    setupCanvases() {
        for (let i = 0; i < 6; i++) {
            const canvas = document.createElement('canvas');
            canvas.width = 1024;
            canvas.height = 1024;
            const ctx = canvas.getContext('2d');
            const tex = new THREE.CanvasTexture(canvas);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            
            this.contentCanvases.push(canvas);
            this.contentCtxs.push(ctx);
            this.contentTextures.push(tex);

            if (i < 5) {
                const mCanvas = document.createElement('canvas');
                mCanvas.width = 1024;
                mCanvas.height = 1024;
                const mCtx = mCanvas.getContext('2d');
                
                mCtx.fillStyle = '#ffffff';
                mCtx.fillRect(0, 0, 1024, 1024);
                
                const mTex = new THREE.CanvasTexture(mCanvas);
                mTex.minFilter = THREE.LinearFilter;
                mTex.magFilter = THREE.LinearFilter;

                this.maskCanvases.push(mCanvas);
                this.maskCtxs.push(mCtx);
                this.maskTextures.push(mTex);
            }
        }
    }

    drawDefaultLayers() {
        const w = 1024;
        const h = 1024;

        const applyCanvasNoise = (ctx, opacity) => {
            const imgData = ctx.getImageData(0, 0, w, h);
            const data = imgData.data;
            for (let i = 0; i < data.length; i += 4) {
                const n = (Math.random() - 0.5) * opacity * 255;
                data[i] = Math.max(0, Math.min(255, data[i] + n));
                data[i+1] = Math.max(0, Math.min(255, data[i+1] + n));
                data[i+2] = Math.max(0, Math.min(255, data[i+2] + n));
            }
            ctx.putImageData(imgData, 0, 0);
        };

        // L1: 现实层
        {
            const ctx = this.contentCtxs[0];
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, '#060a17');
            grad.addColorStop(0.5, '#0b162f');
            grad.addColorStop(1, '#020307');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            ctx.fillStyle = '#ffffff';
            for (let i = 0; i < 150; i++) {
                const r = Math.random() * 2;
                ctx.beginPath();
                ctx.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.strokeStyle = '#e50914';
            ctx.lineWidth = 14;
            ctx.shadowColor = '#e50914';
            ctx.shadowBlur = 20;
            ctx.strokeRect(60, 60, w - 120, h - 120);
            ctx.lineWidth = 4;
            ctx.strokeRect(80, 80, w - 160, h - 160);

            ctx.shadowBlur = 30;
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 95px Oswald, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('HAWKINS 1983', w / 2, h / 2 - 60);

            ctx.font = '36px "Courier Prime", monospace';
            ctx.fillStyle = '#a0a0a5';
            ctx.shadowBlur = 0;
            ctx.fillText('REALITY LEVEL - 01', w / 2, h / 2 + 80);
            applyCanvasNoise(ctx, 0.05);
        }

        // L2: 裂缝层
        {
            const ctx = this.contentCtxs[1];
            const grad = ctx.createRadialGradient(w/2, h/2, 50, w/2, h/2, w/2);
            grad.addColorStop(0, '#3a060a');
            grad.addColorStop(1, '#0c0203');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            ctx.strokeStyle = '#6b0d12';
            ctx.lineWidth = 6;
            for(let i = 0; i < 6; i++) {
                ctx.beginPath();
                ctx.moveTo(Math.random() * w, 0);
                for(let y = 0; y < h; y += 40) {
                    ctx.lineTo(ctx.canvas.width/2 + (Math.random() - 0.5) * 300, y);
                }
                ctx.stroke();
            }
            applyCanvasNoise(ctx, 0.07);
        }

        // L3: 血肉层
        {
            const ctx = this.contentCtxs[2];
            const grad = ctx.createLinearGradient(0, 0, w, h);
            grad.addColorStop(0, '#1c0205');
            grad.addColorStop(0.5, '#4a0810');
            grad.addColorStop(1, '#0e0103');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            ctx.strokeStyle = '#c21c24';
            ctx.lineWidth = 3;
            ctx.shadowColor = '#ff2233';
            ctx.shadowBlur = 4;
            for (let i = 0; i < 35; i++) {
                ctx.beginPath();
                ctx.moveTo(Math.random() * w, Math.random() * h);
                ctx.bezierCurveTo(
                    Math.random() * w, Math.random() * h,
                    Math.random() * w, Math.random() * h,
                    Math.random() * w, Math.random() * h
                );
                ctx.stroke();
            }
            ctx.shadowBlur = 0;
            applyCanvasNoise(ctx, 0.08);
        }

        // L4: 发光层
        {
            const ctx = this.contentCtxs[3];
            const grad = ctx.createRadialGradient(w/2, h/2, 20, w/2, h/2, w/2);
            grad.addColorStop(0, '#7c1015');
            grad.addColorStop(0.6, '#300407');
            grad.addColorStop(1, '#080002');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            ctx.strokeStyle = '#ff6a00';
            ctx.shadowColor = '#ff8c00';
            ctx.shadowBlur = 15;
            for (let i = 0; i < 15; i++) {
                ctx.lineWidth = 3 + Math.random() * 8;
                ctx.beginPath();
                ctx.moveTo(Math.random() * w, Math.random() * h);
                ctx.quadraticCurveTo(w/2, h/2, Math.random() * w, Math.random() * h);
                ctx.stroke();
            }
            ctx.shadowBlur = 0;
            applyCanvasNoise(ctx, 0.05);
        }

        // L5: 深渊边缘
        {
            const ctx = this.contentCtxs[4];
            ctx.fillStyle = '#06010a';
            ctx.fillRect(0, 0, w, h);

            for (let i = 0; i < 10; i++) {
                const rad = 200 + Math.random() * 200;
                const cx = Math.random() * w;
                const cy = Math.random() * h;
                const fogGrad = ctx.createRadialGradient(cx, cy, 10, cx, cy, rad);
                fogGrad.addColorStop(0, i % 2 === 0 ? 'rgba(92, 10, 112, 0.45)' : 'rgba(23, 10, 92, 0.45)');
                fogGrad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = fogGrad;
                ctx.beginPath();
                ctx.arc(cx, cy, rad, 0, Math.PI * 2);
                ctx.fill();
            }
            applyCanvasNoise(ctx, 0.09);
        }

        // L6: 颠倒世界
        {
            const ctx = this.contentCtxs[5];
            const grad = ctx.createRadialGradient(w/2, h/2, 100, w/2, h/2, w/2);
            grad.addColorStop(0, '#0c1b33');
            grad.addColorStop(0.7, '#040714');
            grad.addColorStop(1, '#000002');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            ctx.fillStyle = 'rgba(2, 4, 10, 0.92)';
            ctx.beginPath();
            ctx.arc(w / 2, h / 2 - 100, 120, 0, Math.PI * 2);
            ctx.fill();

            ctx.lineWidth = 35;
            ctx.strokeStyle = 'rgba(2, 4, 10, 0.92)';
            ctx.lineCap = 'round';
            for (let i = 0; i < 8; i++) {
                ctx.beginPath();
                ctx.moveTo(w / 2, h / 2 - 100);
                ctx.bezierCurveTo(
                    w/2 + (i - 3.5) * 150, h/2 + 100,
                    w/2 + (i - 3.5) * 200 + (Math.random() - 0.5) * 200, h/2 + 400,
                    Math.random() * w, h + 100
                );
                ctx.stroke();
            }
            applyCanvasNoise(ctx, 0.06);
        }

        for (let i = 0; i < 6; i++) {
            this.contentTextures[i].needsUpdate = true;
        }
    }

    setupBackgroundParticles() {
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(this.sporeCount * 3);
        const velocities = [];

        for (let i = 0; i < this.sporeCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 20;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 15;
            positions[i * 3 + 2] = CONFIG.bgZ + 0.1 + Math.random() * 4.5;

            velocities.push({
                x: (Math.random() - 0.5) * 0.01,
                y: 0.004 + Math.random() * 0.012,
                speedX: 0.01 + Math.random() * 0.025,
                amplitudeX: 0.15 + Math.random() * 0.35
            });
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        
        const material = new THREE.PointsMaterial({
            color: 0xff3b11,
            size: 0.14,
            transparent: true,
            opacity: 0.70,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        this.sporeSystem = new THREE.Points(geometry, material);
        this.sporeSystem.customVelocities = velocities;
        this.scene.add(this.sporeSystem);
    }

    setupMeshes() {
        const segW = CONFIG.gridWidth;
        const segH = CONFIG.gridHeight;

        const noiseShaderSnippet = `
            float rand(vec2 co){
                return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
            }
            float noise(vec2 st) {
                vec2 i = floor(st);
                vec2 f = fract(st);
                float a = rand(i);
                float b = rand(i + vec2(1.0, 0.0));
                float c = rand(i + vec2(0.0, 1.0));
                float d = rand(i + vec2(1.0, 1.0));
                vec2 u = f*f*(3.0-2.0*f);
                return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
            }
        `;

        for (let i = 0; i < 5; i++) {
            const layerCfg = CONFIG.layers[i];
            
            const cloth = new Cloth(CONFIG.clothWidth, CONFIG.clothHeight, segW, segH, layerCfg.tear, layerCfg.restoring);
            this.cloths.push(cloth);

            const geom = new THREE.PlaneGeometry(CONFIG.clothWidth, CONFIG.clothHeight, segW, segH);
            
            const mat = new THREE.ShaderMaterial({
                uniforms: {
                    mainTex: { value: this.contentTextures[i] },
                    maskTex: { value: this.maskTextures[i] },
                    glowIntensity: { value: i === 0 ? 0.0 : 1.8 }
                },
                vertexShader: `
                    varying vec2 vUv;
                    varying vec3 vNormal;
                    void main() {
                        vUv = uv;
                        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                        vNormal = normalMatrix * normal;
                        gl_Position = projectionMatrix * mvPosition;
                    }
                `,
                fragmentShader: `
                    uniform sampler2D mainTex;
                    uniform sampler2D maskTex;
                    uniform float glowIntensity;
                    varying vec2 vUv;
                    varying vec3 vNormal;
                    
                    ${noiseShaderSnippet}

                    void main() {
                        float maskVal = texture2D(maskTex, vUv).r;
                        float n = noise(vUv * (140.0 + glowIntensity * 10.0)) * 0.16;
                        float border = maskVal + n;
                        
                        if (border < 0.48) {
                            discard;
                        }

                        vec4 baseColor = texture2D(mainTex, vUv);
                        
                        vec3 normal = normalize(vNormal);
                        vec3 lightDir = normalize(vec3(0.4, 0.4, 1.0));
                        float ndl = max(0.28, dot(normal, lightDir));
                        
                        vec3 finalColor = baseColor.rgb * ndl;

                        if (glowIntensity > 0.0) {
                            float glowFactor = 1.0 - smoothstep(0.48, 0.62, border);
                            vec3 glowColor = vec3(1.0, 0.10, 0.02) * glowFactor * glowIntensity;
                            finalColor += glowColor;
                        } else {
                            float edgeDarken = smoothstep(0.48, 0.54, border);
                            finalColor = mix(finalColor * 0.2, finalColor, edgeDarken);
                        }

                        gl_FragColor = vec4(finalColor, 1.0);
                    }
                `,
                side: THREE.DoubleSide
            });

            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.z = layerCfg.z;
            this.scene.add(mesh);
            this.meshes.push(mesh);
        }

        const bgGeom = new THREE.PlaneGeometry(CONFIG.clothWidth * 1.35, CONFIG.clothHeight * 1.35);
        const bgMat = new THREE.MeshBasicMaterial({
            map: this.contentTextures[5],
            depthWrite: false
        });
        const bgMesh = new THREE.Mesh(bgGeom, bgMat);
        bgMesh.position.z = CONFIG.bgZ;
        this.scene.add(bgMesh);
        this.meshes.push(bgMesh);
    }

    setupEvents() {
        // --- 鼠标/触屏事件（归入 mouse 虚拟操作指针） ---
        const onPointerDown = (e) => {
            if (!state.loadingComplete || state.isResetting) return;
            
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            
            const pointer = state.pointers.mouse;
            pointer.active = true;
            this.updatePointerNdc(pointer, clientX, clientY);

            if (state.audioEnabled && !state.audioInitialized) {
                sounds.init();
                sounds.setVolume(0.45);
            }

            this.attemptGrabForPointer(pointer);
        };

        const onPointerMove = (e) => {
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            
            this.targetRotation.x = (clientX / window.innerWidth - 0.5) * 0.05;
            this.targetRotation.y = (clientY / window.innerHeight - 0.5) * 0.05;

            const pointer = state.pointers.mouse;
            if (!pointer.active || !pointer.draggedParticle) return;
            
            this.updatePointerNdc(pointer, clientX, clientY);
            this.updateDragPositionForPointer(pointer);
        };

        const onPointerUp = () => {
            const pointer = state.pointers.mouse;
            this.releasePointer(pointer);
        };

        window.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);

        window.addEventListener('touchstart', onPointerDown, { passive: true });
        window.addEventListener('touchmove', onPointerMove, { passive: true });
        window.addEventListener('touchend', onPointerUp);
    }

    updatePointerNdc(pointer, screenX, screenY) {
        pointer.ndc.x = (screenX / window.innerWidth) * 2 - 1;
        pointer.ndc.y = -(screenY / window.innerHeight) * 2 + 1;
    }

    // --- 通用：锁定并抓取指针对应的最近质点 ---
    attemptGrabForPointer(pointer) {
        this.raycaster.setFromCamera(pointer.ndc, this.camera);

        for (let i = 0; i < 5; i++) {
            const intersects = this.raycaster.intersectObject(this.meshes[i]);
            if (intersects.length > 0) {
                const hit = intersects[0];
                const uv = hit.uv;
                
                if (this.checkMaskValue(i, uv) > 10) {
                    pointer.activeClothIndex = i;
                    this.grabNearestParticleForPointer(pointer, this.cloths[i], hit.point);
                    return;
                }
            }
        }
    }

    grabNearestParticleForPointer(pointer, cloth, hitPoint) {
        let nearest = null;
        let minDist = Infinity;

        for (let i = 0; i < cloth.particles.length; i++) {
            const p = cloth.particles[i];
            
            const segmentsW = CONFIG.gridWidth;
            const segmentsH = CONFIG.gridHeight;
            const y_idx = Math.floor(i / (segmentsW + 1));
            const x_idx = i % (segmentsW + 1);
            if (x_idx === 0 || x_idx === segmentsW || y_idx === 0 || y_idx === segmentsH) {
                continue;
            }

            const dist = p.position.distanceTo(hitPoint);
            if (dist < minDist) {
                minDist = dist;
                nearest = p;
            }
        }

        if (nearest) {
            pointer.draggedParticle = nearest;
            nearest.pinned = true;
            nearest.pinPosition.copy(hitPoint);
            pointer.targetDragPos.copy(hitPoint);
        }
    }

    // --- 通用：更新指针对应的拖拽位置（带Z轴起伏） ---
    updateDragPositionForPointer(pointer) {
        if (!pointer.draggedParticle || pointer.activeClothIndex === null) return;

        const currentCfg = CONFIG.layers[pointer.activeClothIndex];
        const planeZ = currentCfg.z;
        const targetPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
        
        this.raycaster.setFromCamera(pointer.ndc, this.camera);
        const dragPoint = new THREE.Vector3();
        this.raycaster.ray.intersectPlane(targetPlane, dragPoint);

        const center = pointer.draggedParticle.original;
        const dragDist = dragPoint.distanceTo(center);
        
        const maxOffsetZ = pointer.activeClothIndex === 0 ? 1.5 : 0.8;
        dragPoint.z = Math.min(maxOffsetZ, dragDist * 0.12);

        pointer.targetDragPos.lerp(dragPoint, 0.22);
        pointer.draggedParticle.pinPosition.copy(pointer.targetDragPos);

        if (state.audioEnabled && state.audioInitialized) {
            const stretch = pointer.draggedParticle.position.distanceTo(pointer.draggedParticle.original);
            sounds.updateTension(dragPoint.distanceTo(pointer.draggedParticle.position), stretch);
        }
    }

    releasePointer(pointer) {
        if (pointer.draggedParticle) {
            pointer.draggedParticle.pinned = false;
            pointer.draggedParticle = null;
        }
        pointer.active = false;
        pointer.activeClothIndex = null;
        sounds.stopTension();
    }

    checkMaskValue(index, uv) {
        const ctx = this.maskCtxs[index];
        const x = Math.floor(uv.x * 1024);
        const y = Math.floor((1.0 - uv.y) * 1024);
        
        try {
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            return pixel[0];
        } catch(e) {
            return 255;
        }
    }

    drawTear(index, p1, p2) {
        const ctx = this.maskCtxs[index];
        const texture = this.maskTextures[index];

        const u1 = p1.uv.x * 1024;
        const v1 = (1.0 - p1.uv.y) * 1024;
        const u2 = p2.uv.x * 1024;
        const v2 = (1.0 - p2.uv.y) * 1024;

        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        
        const dist = Math.hypot(u2 - u1, v2 - v1);
        const steps = Math.max(10, Math.floor(dist / 4));

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const cx = u1 + (u2 - u1) * t + (Math.random() - 0.5) * 14;
            const cy = v1 + (v2 - v1) * t + (Math.random() - 0.5) * 14;
            const r = 12 + Math.random() * 26;

            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
        texture.needsUpdate = true;
    }

    setupUI() {
        const btnAudio = document.getElementById('btn-audio');
        const btnGesture = document.getElementById('btn-gesture');
        const btnUpload = document.getElementById('btn-upload');
        const inputUpload = document.getElementById('input-upload');
        const btnReset = document.getElementById('btn-reset');

        btnAudio.addEventListener('click', () => {
            state.audioEnabled = !state.audioEnabled;
            if (state.audioEnabled) {
                sounds.init();
                sounds.setVolume(0.45);
                btnAudio.innerHTML = '<span class="icon">🔊</span> 音效: 开';
            } else {
                sounds.setVolume(0.0);
                btnAudio.innerHTML = '<span class="icon">🔇</span> 音效: 关';
            }
        });

        // 摄像头手势交互开启/关闭
        btnGesture.addEventListener('click', () => {
            this.toggleGesture();
        });

        btnUpload.addEventListener('click', () => {
            inputUpload.click();
        });

        inputUpload.addEventListener('change', (e) => {
            this.handleImageUpload(e.target.files);
        });

        btnReset.addEventListener('click', () => {
            this.resetScene();
        });
    }

    // --- 摄像头与 MediaPipe Hands 初始化与控制 ---
    toggleGesture() {
        const btnGesture = document.getElementById('btn-gesture');
        const container = document.getElementById('webcam-container');

        state.gestureEnabled = !state.gestureEnabled;

        if (state.gestureEnabled) {
            btnGesture.innerHTML = '<span class="icon">🖐️</span> 手势: 开';
            btnGesture.classList.add('active');
            container.style.display = 'flex';

            if (!state.gestureInitialized) {
                this.initMediaPipe();
            } else {
                if (this.videoElement.srcObject) {
                    this.videoElement.play();
                }
            }
        } else {
            btnGesture.innerHTML = '<span class="icon">🖐️</span> 手势: 关';
            btnGesture.classList.remove('active');
            container.style.display = 'none';
            
            // 暂停摄像头读取，释放指针
            this.videoElement.pause();
            this.releasePointer(state.pointers.leftHand);
            this.releasePointer(state.pointers.rightHand);
        }
    }

    initMediaPipe() {
        if (typeof Hands === 'undefined') {
            console.error('MediaPipe Hands 库尚未载入！');
            return;
        }

        // 实例 Hands 核心识别器
        this.mpHands = new Hands({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });

        this.mpHands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.60,
            minTrackingConfidence: 0.60
        });

        this.mpHands.onResults((results) => this.onHandResults(results));

        // 开启摄像头数据回路
        this.mpCamera = new Camera(this.videoElement, {
            onFrame: async () => {
                if (state.gestureEnabled) {
                    await this.mpHands.send({ image: this.videoElement });
                }
            },
            width: 160,
            height: 120
        });

        this.mpCamera.start().then(() => {
            state.gestureInitialized = true;
        }).catch((err) => {
            console.error('摄像头开启失败或权限被拒:', err);
            // 降级回退处理
            state.gestureEnabled = false;
            const btnGesture = document.getElementById('btn-gesture');
            btnGesture.innerHTML = '<span class="icon">🖐️</span> 手势: 错';
            btnGesture.classList.remove('active');
            document.getElementById('webcam-container').style.display = 'none';
        });
    }

    // --- 摄像头检测回调：分析双手并触发物理捏合拉扯 ---
    onHandResults(results) {
        const ctx = this.webcamCtx;
        const cw = this.webcamCanvas.width;
        const ch = this.webcamCanvas.height;

        // 1. 镜像清除并绘制当前摄像头画面以提供预览
        ctx.save();
        ctx.translate(cw, 0);
        ctx.scale(-1, 1); // 镜像反转
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(results.image, 0, 0, cw, ch);
        ctx.restore();

        // 2. 重置手势指针活跃状态，如果在 results 里未识别，则释放对应指针
        let detectedPointers = { leftHand: false, rightHand: false };

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            for (let i = 0; i < results.multiHandLandmarks.length; i++) {
                const landmarks = results.multiHandLandmarks[i];
                
                // 大拇指尖 (4号) 和食指尖 (8号)
                const thumb = landmarks[4];
                const indexFinger = landmarks[8];

                // 计算 3D 捏合距离 (Pinch Distance)
                const dist = Math.hypot(
                    thumb.x - indexFinger.x,
                    thumb.y - indexFinger.y,
                    (thumb.z - indexFinger.z) * 0.4 // 适当微弱化 Z 轴的深度差影响
                );

                const isPinched = dist < 0.052; // 捏合激活阈值

                // 根据手心横坐标确定是“左指针”还是“右指针” (以中点在画面左/右侧区分最稳健)
                const pinchX = (thumb.x + indexFinger.x) / 2;
                const pinchY = (thumb.y + indexFinger.y) / 2;
                
                // 由于摄像头被镜像了，我们将手部的 X 坐标进行对称映射
                const mappedX = 1.0 - pinchX; 
                const mappedY = pinchY;

                // 区分左/右手虚拟指针
                const pointerKey = pinchX > 0.5 ? 'leftHand' : 'rightHand'; // 摄像头画面左侧为物理右侧手
                const pointer = state.pointers[pointerKey];
                detectedPointers[pointerKey] = true;

                // 将坐标转化为 NDC 坐标传入射线检测
                pointer.ndc.x = mappedX * 2 - 1;
                pointer.ndc.y = -mappedY * 2 + 1;

                if (isPinched) {
                    if (!pointer.active) {
                        pointer.active = true;
                        this.attemptGrabForPointer(pointer);
                    } else {
                        this.updateDragPositionForPointer(pointer);
                    }
                } else {
                    if (pointer.active) {
                        this.releasePointer(pointer);
                    }
                }

                // 3. 在小窗口 Canvas 上绘制手部骨骼连线 (做镜像位置转换)
                this.drawWebcamHandSkeleton(ctx, landmarks, cw, ch, isPinched);
            }
        }

        // 4. 清理失联（飞出镜头）的手势指针
        if (!detectedPointers.leftHand && state.pointers.leftHand.active) {
            this.releasePointer(state.pointers.leftHand);
        }
        if (!detectedPointers.rightHand && state.pointers.rightHand.active) {
            this.releasePointer(state.pointers.rightHand);
        }
    }

    drawWebcamHandSkeleton(ctx, landmarks, cw, ch, isPinched) {
        ctx.save();
        // 关键点渲染需要镜像翻转 (因为视频本身也是镜像翻转在 canvas 上的)
        const getCanvasCoords = (lm) => {
            return {
                x: (1.0 - lm.x) * cw,
                y: lm.y * ch
            };
        };

        // 绘制骨节连线
        ctx.strokeStyle = isPinched ? '#ffd700' : '#ff3333'; // 捏合时金黄色，平时红色
        ctx.lineWidth = 1.5;

        // 五根手指骨骼回路连接
        const fingerPaths = [
            [0, 1, 2, 3, 4],       // 大拇指
            [0, 5, 6, 7, 8],       // 食指
            [0, 9, 10, 11, 12],    // 中指
            [0, 13, 14, 15, 16],   // 无名指
            [0, 17, 18, 19, 20],   // 小拇指
            [5, 9, 13, 17]         // 手掌横连
        ];

        fingerPaths.forEach(path => {
            ctx.beginPath();
            const start = getCanvasCoords(landmarks[path[0]]);
            ctx.moveTo(start.x, start.y);
            for (let i = 1; i < path.length; i++) {
                const pt = getCanvasCoords(landmarks[path[i]]);
                ctx.lineTo(pt.x, pt.y);
            }
            ctx.stroke();
        });

        // 绘制 21 个物理质点 (绿色小圆圈)
        ctx.fillStyle = '#00ff33';
        for (let i = 0; i < 21; i++) {
            const pt = getCanvasCoords(landmarks[i]);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // 高亮捏合大拇指和食指连线
        if (isPinched) {
            const pThumb = getCanvasCoords(landmarks[4]);
            const pIndex = getCanvasCoords(landmarks[8]);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(pThumb.x, pThumb.y);
            ctx.lineTo(pIndex.x, pIndex.y);
            ctx.stroke();
            
            // 在中点上画个高亮金黄色实心圈
            ctx.fillStyle = '#ffd700';
            ctx.beginPath();
            ctx.arc((pThumb.x + pIndex.x)/2, (pThumb.y + pIndex.y)/2, 5, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    handleImageUpload(files) {
        if (!files || files.length === 0) return;

        const count = Math.min(files.length, 6);
        const imgElements = [];
        let loadedCount = 0;

        const overlay = document.getElementById('loading-overlay');
        const percentText = document.getElementById('loading-percent');
        const progressBar = document.getElementById('loading-bar');
        
        overlay.classList.remove('fade-out');
        percentText.innerText = '0%';
        progressBar.style.width = '0%';

        const triggerLoadDone = () => {
            this.rebuildLayersFromImages(imgElements);
            this.resetScene();
            
            progressBar.style.width = '100%';
            percentText.innerText = '100%';
            setTimeout(() => {
                overlay.classList.add('fade-out');
            }, 500);
        };

        for (let i = 0; i < count; i++) {
            const file = files[i];
            const img = new Image();
            img.src = URL.createObjectURL(file);
            imgElements.push(img);

            img.onload = () => {
                loadedCount++;
                const pct = Math.round((loadedCount / count) * 100);
                progressBar.style.width = `${pct}%`;
                percentText.innerText = `${pct}%`;

                if (loadedCount === count) {
                    const lastImg = imgElements[imgElements.length - 1];
                    while (imgElements.length < 6) {
                        imgElements.push(lastImg);
                    }
                    triggerLoadDone();
                }
            };

            img.onerror = () => {
                loadedCount++;
                if (loadedCount === count) {
                    triggerLoadDone();
                }
            };
        }
    }

    rebuildLayersFromImages(images) {
        const cw = 1024;
        const ch = 1024;

        for (let i = 0; i < 6; i++) {
            const img = images[i];
            const ctx = this.contentCtxs[i];
            
            ctx.clearRect(0, 0, cw, ch);

            if (img && img.complete && img.naturalWidth > 0) {
                const iw = img.naturalWidth;
                const ih = img.naturalHeight;
                
                const scale = Math.max(cw / iw, ch / ih);
                const w = iw * scale;
                const h = ih * scale;
                
                const dx = (cw - w) / 2;
                const dy = (ch - h) / 2;

                ctx.drawImage(img, dx, dy, w, h);
            } else {
                ctx.fillStyle = '#080104';
                ctx.fillRect(0, 0, cw, ch);
            }

            this.contentTextures[i].needsUpdate = true;
        }
    }

    resetScene() {
        if (state.isResetting) return;
        state.isResetting = true;
        
        let count = 0;
        const flashInterval = setInterval(() => {
            this.scene.background = new THREE.Color(count % 2 === 0 ? 0x220508 : 0x040102);
            count++;
            if (count > 4) {
                clearInterval(flashInterval);
                this.scene.background = new THREE.Color(0x040102);
                
                for (let i = 0; i < 5; i++) {
                    this.cloths[i].reset();
                    
                    const mCtx = this.maskCtxs[i];
                    mCtx.fillStyle = '#ffffff';
                    mCtx.fillRect(0, 0, 1024, 1024);
                    this.maskTextures[i].needsUpdate = true;
                }

                // 释放所有手势及鼠标指针
                this.releasePointer(state.pointers.mouse);
                this.releasePointer(state.pointers.leftHand);
                this.releasePointer(state.pointers.rightHand);

                state.isResetting = false;
            }
        }, 100);
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        const dt = Math.min(this.clock.getDelta(), 0.02);

        if (!state.isResetting) {
            for (let index = 0; index < 5; index++) {
                const cloth = this.cloths[index];
                const rip = cloth.update(dt);

                if (rip) {
                    let ripOccurred = false;
                    for (let i = 0; i < cloth.constraints.length; i++) {
                        const c = cloth.constraints[i];
                        if (c.broken && !c.drawn) {
                            this.drawTear(index, c.p1, c.p2);
                            c.drawn = true;
                            ripOccurred = true;
                        }
                    }
                    if (ripOccurred && state.audioEnabled && state.audioInitialized) {
                        sounds.playRipSound();
                    }
                }

                this.syncGeometry(this.meshes[index].geometry, cloth);
            }
        }

        this.animateBackgroundParticles();

        this.camera.rotation.y += (this.targetRotation.x - this.camera.rotation.y) * 0.05;
        this.camera.rotation.x += (this.targetRotation.y - this.camera.rotation.x) * 0.05;

        if (Math.random() < 0.003) {
            this.triggerLightning();
        }

        this.renderer.render(this.scene, this.camera);
    }

    syncGeometry(geometry, cloth) {
        const positions = geometry.attributes.position.array;
        for (let i = 0; i < cloth.particles.length; i++) {
            const p = cloth.particles[i];
            positions[i * 3] = p.position.x;
            positions[i * 3 + 1] = p.position.y;
            positions[i * 3 + 2] = p.position.z;
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.computeVertexNormals();
    }

    animateBackgroundParticles() {
        if (!this.sporeSystem) return;
        const positions = this.sporeSystem.geometry.attributes.position.array;
        const vels = this.sporeSystem.customVelocities;
        const time = Date.now() * 0.001;

        for (let i = 0; i < this.sporeCount; i++) {
            const vel = vels[i];
            positions[i * 3] += Math.sin(time * vel.speedX) * 0.004 + vel.x;
            positions[i * 3 + 1] += vel.y;
            
            if (positions[i * 3 + 1] > 8) {
                positions[i * 3 + 1] = -8;
                positions[i * 3] = (Math.random() - 0.5) * 20;
            }
        }
        this.sporeSystem.geometry.attributes.position.needsUpdate = true;
    }

    triggerLightning() {
        const originalColor = new THREE.Color(0x040102);
        const flashColor = new THREE.Color(0x24050a);
        
        this.scene.background = flashColor;
        
        setTimeout(() => {
            this.scene.background = originalColor;
            if (Math.random() < 0.4) {
                setTimeout(() => {
                    this.scene.background = flashColor;
                    setTimeout(() => {
                        this.scene.background = originalColor;
                    }, 50);
                }, 80);
            }
        }, 60);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new App();
});
