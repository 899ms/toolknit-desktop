import { createBackgroundFrameLimiter } from './shared/animation-policy.js';

export class GradientWaves {
  static defaults = {
    horizonColor: '#5227FF',
    waveColor: '#FF9FFC',
    crestColor: '#FFFFFF',
    speed: 0.4,
    amplitude: 2.5,
    waveScale: 0.6,
    waveRatio: 0.9,
    swell: 35,
    turbulence: 20,
    tilt: 1.11,
    zoom: 1.0,
    height: 5.5,
    fogDepth: 15,
    detail: 'medium',
    brightness: 1.0,
    opacity: 1.0,
    mouseInteraction: true,
    parallaxStrength: 0.5,
    grain: true,
    grainIntensity: 0.05
  };

  static detailToSteps(detail) {
    if (detail === 'low') return 40.0;
    if (detail === 'high') return 110.0;
    return 70.0;
  }

  static hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return [1, 1, 1];
    return [
      parseInt(result[1], 16) / 255,
      parseInt(result[2], 16) / 255,
      parseInt(result[3], 16) / 255
    ];
  }

  constructor(container, options = {}) {
    this.container = typeof container === 'string'
      ? document.querySelector(container)
      : container;

    if (!this.container) {
      throw new Error('GradientWaves: container not found');
    }

    this.options = { ...GradientWaves.defaults, ...options };
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.25);

    this.currentMouse = [0.5, 0.5];
    this.targetMouse = [0.5, 0.5];
    this.raf = 0;
    this.isVisible = true;
    this.isPageVisible = !document.hidden;
    this.t0 = performance.now();
    this.frameLimiter = createBackgroundFrameLimiter();

    this.init();
  }

  init() {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.container.appendChild(this.canvas);

    this.gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false
    });

    if (!this.gl) {
      throw new Error('GradientWaves: WebGL2 is not supported in this browser');
    }

    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);

    this.program = this.createProgram(gl, vertexShader, fragmentShader);
    gl.useProgram(this.program);

    this.locations = {
      position: gl.getAttribLocation(this.program, 'position'),
      iTime: gl.getUniformLocation(this.program, 'iTime'),
      iResolution: gl.getUniformLocation(this.program, 'iResolution'),
      uSpeed: gl.getUniformLocation(this.program, 'uSpeed'),
      uAmplitude: gl.getUniformLocation(this.program, 'uAmplitude'),
      uWaveScale: gl.getUniformLocation(this.program, 'uWaveScale'),
      uWaveRatio: gl.getUniformLocation(this.program, 'uWaveRatio'),
      uSwell: gl.getUniformLocation(this.program, 'uSwell'),
      uTurbulence: gl.getUniformLocation(this.program, 'uTurbulence'),
      uTilt: gl.getUniformLocation(this.program, 'uTilt'),
      uZoom: gl.getUniformLocation(this.program, 'uZoom'),
      uHeight: gl.getUniformLocation(this.program, 'uHeight'),
      uFogDepth: gl.getUniformLocation(this.program, 'uFogDepth'),
      uSteps: gl.getUniformLocation(this.program, 'uSteps'),
      uBrightness: gl.getUniformLocation(this.program, 'uBrightness'),
      uOpacity: gl.getUniformLocation(this.program, 'uOpacity'),
      uGrain: gl.getUniformLocation(this.program, 'uGrain'),
      uGrainIntensity: gl.getUniformLocation(this.program, 'uGrainIntensity'),
      uMouse: gl.getUniformLocation(this.program, 'uMouse'),
      uParallax: gl.getUniformLocation(this.program, 'uParallax'),
      uEnableMouse: gl.getUniformLocation(this.program, 'uEnableMouse'),
      uHorizonColor: gl.getUniformLocation(this.program, 'uHorizonColor'),
      uWaveColor: gl.getUniformLocation(this.program, 'uWaveColor'),
      uCrestColor: gl.getUniformLocation(this.program, 'uCrestColor')
    };

    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.setUniforms();
    this.bindEvents();
    this.resize();
    this.tryStart();
  }

  createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`GradientWaves: shader compile error\n${info}`);
    }

    return shader;
  }

  createProgram(gl, vertexSource, fragmentSource) {
    const vertex = this.createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = this.createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`GradientWaves: program link error\n${info}`);
    }

    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    return program;
  }

  setUniforms() {
    const gl = this.gl;
    const o = this.options;

    gl.uniform1f(this.locations.uSpeed, o.speed);
    gl.uniform1f(this.locations.uAmplitude, o.amplitude);
    gl.uniform1f(this.locations.uWaveScale, o.waveScale);
    gl.uniform1f(this.locations.uWaveRatio, o.waveRatio);
    gl.uniform1f(this.locations.uSwell, o.swell);
    gl.uniform1f(this.locations.uTurbulence, o.turbulence);
    gl.uniform1f(this.locations.uTilt, o.tilt);
    gl.uniform1f(this.locations.uZoom, o.zoom);
    gl.uniform1f(this.locations.uHeight, o.height);
    gl.uniform1f(this.locations.uFogDepth, o.fogDepth);
    gl.uniform1f(this.locations.uSteps, GradientWaves.detailToSteps(o.detail));
    gl.uniform1f(this.locations.uBrightness, o.brightness);
    gl.uniform1f(this.locations.uOpacity, o.opacity);
    gl.uniform1f(this.locations.uGrain, o.grain ? 1.0 : 0.0);
    gl.uniform1f(this.locations.uGrainIntensity, o.grainIntensity);
    gl.uniform1f(this.locations.uParallax, o.parallaxStrength);
    gl.uniform1i(this.locations.uEnableMouse, o.mouseInteraction ? 1 : 0);
    gl.uniform2f(this.locations.uMouse, 0.5, 0.5);

    const h = GradientWaves.hexToRgb(o.horizonColor);
    const w = GradientWaves.hexToRgb(o.waveColor);
    const c = GradientWaves.hexToRgb(o.crestColor);
    gl.uniform3f(this.locations.uHorizonColor, h[0], h[1], h[2]);
    gl.uniform3f(this.locations.uWaveColor, w[0], w[1], w[2]);
    gl.uniform3f(this.locations.uCrestColor, c[0], c[1], c[2]);
  }

  updateOption(key, value) {
    if (!(key in this.options)) return;
    this.options[key] = value;
    this.setUniforms();
  }

  updateOptions(options) {
    Object.assign(this.options, options);
    this.setUniforms();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));

    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.uniform2f(this.locations.iResolution, this.canvas.width, this.canvas.height);
    this.renderOnce();
  }

  bindEvents() {
    this.onPointerMove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.targetMouse[0] = (e.clientX - rect.left) / rect.width;
      this.targetMouse[1] = 1.0 - (e.clientY - rect.top) / rect.height;
    };

    this.onPointerLeave = () => {
      this.targetMouse[0] = 0.5;
      this.targetMouse[1] = 0.5;
    };

    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        this.isVisible = entry.isIntersecting;
        this.isVisible ? this.tryStart() : this.tryStop();
      },
      { threshold: 0 }
    );
    this.intersectionObserver.observe(this.container);

    this.onVisibility = () => {
      this.isPageVisible = !document.hidden;
      this.isPageVisible ? this.tryStart() : this.tryStop();
    };
    this.onPageHide = () => {
      this.isPageVisible = false;
      this.tryStop();
    };
    this.onPageShow = () => {
      this.isPageVisible = !document.hidden;
      this.isPageVisible ? this.tryStart() : this.tryStop();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
  }

  tryStart() {
    if (this.isVisible && this.isPageVisible && this.raf === 0) {
      this.raf = requestAnimationFrame((t) => this.loop(t));
    }
  }

  tryStop() {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  loop(t) {
    const gl = this.gl;

    if (!this.frameLimiter.shouldRender(t)) {
      this.raf = requestAnimationFrame((time) => this.loop(time));
      return;
    }

    gl.uniform1f(this.locations.iTime, (t - this.t0) * 0.001);

    const tx = this.options.mouseInteraction ? this.targetMouse[0] : 0.5;
    const ty = this.options.mouseInteraction ? this.targetMouse[1] : 0.5;
    this.currentMouse[0] += 0.05 * (tx - this.currentMouse[0]);
    this.currentMouse[1] += 0.05 * (ty - this.currentMouse[1]);
    gl.uniform2f(this.locations.uMouse, this.currentMouse[0], this.currentMouse[1]);

    this.renderOnce();

    this.raf = requestAnimationFrame((time) => this.loop(time));
  }

  renderOnce() {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  destroy() {
    this.tryStop();

    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);

    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();

    if (this.gl) {
      this.gl.deleteVertexArray(this.vao);
      this.gl.deleteBuffer(this.buffer);
      this.gl.deleteProgram(this.program);
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}

const vertexShader = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaveScale;
uniform float uWaveRatio;
uniform float uSwell;
uniform float uTurbulence;
uniform float uTilt;
uniform float uZoom;
uniform float uHeight;
uniform float uFogDepth;
uniform float uSteps;
uniform float uBrightness;
uniform float uOpacity;
uniform float uGrain;
uniform float uGrainIntensity;
uniform vec2 uMouse;
uniform float uParallax;
uniform bool uEnableMouse;
uniform vec3 uHorizonColor;
uniform vec3 uWaveColor;
uniform vec3 uCrestColor;
out vec4 fragColor;

const float MAX_DIST = 20000.0;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float plasma(vec3 r, vec2 freq, vec4 tc) {
  float mx = r.x + tc.x;
  mx += uSwell * sin((r.y + mx) / 20.0 + tc.y);
  float my = r.y - tc.z;
  my += uTurbulence * cos(r.x / 23.0 + tc.w);
  return r.z - (sin(mx * freq.x) * uAmplitude + sin(my * freq.y) * uAmplitude + uHeight);
}

float raymarch(vec3 pos, vec3 dir, vec2 freq, vec4 tc) {
  float dist = 0.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= uSteps) break;
    float dscene = plasma(pos + dist * dir, freq, tc);
    if (abs(dscene) < 0.1) break;
    dist += 0.9 * dscene;
    if (!(abs(dist) < MAX_DIST)) return MAX_DIST;
  }
  return dist;
}

void main() {
  float T = iTime * uSpeed;
  vec2 freq = vec2(uWaveScale / 7.0, (uWaveScale * uWaveRatio) / 3.0);
  vec4 tc = vec4(T / 0.130, T / 0.810, T / 0.200, T / 0.710);
  float c, s;
  float vfov = (3.14159 / 2.3) / max(uZoom, 0.05);
  vec3 cam = vec3(0.0, 0.0, 30.0);
  vec2 uv = (gl_FragCoord.xy / iResolution.xy) - 0.5;
  uv.x *= iResolution.x / iResolution.y;
  uv.y *= -1.0;

  vec3 dir = vec3(0.0, 0.0, -1.0);
  float ulen = length(uv);
  float xrot = vfov * ulen;
  c = cos(xrot); s = sin(xrot);
  dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  vec2 nuv = ulen > 1e-5 ? uv / ulen : vec2(1.0, 0.0);
  c = nuv.x; s = nuv.y;
  dir = mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0) * dir;
  c = cos(uTilt); s = sin(uTilt);
  dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;

  if (uEnableMouse) {
    float yaw = (uMouse.x - 0.5) * uParallax * 0.4;
    float pitch = (uMouse.y - 0.5) * uParallax * 0.4;
    c = cos(yaw); s = sin(yaw);
    dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;
    c = cos(pitch); s = sin(pitch);
    dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  }

  float dist = raymarch(cam, dir, freq, tc);
  vec3 pos = cam + dist * dir;

  float t = clamp(uFogDepth / max(dist, 0.001), 0.0, 1.0);
  vec3 body = mix(uWaveColor, uCrestColor, clamp(pos.z * 0.08 + 0.5, 0.0, 1.0));
  vec3 col = mix(uHorizonColor, body, t);
  col *= uBrightness;
  col = clamp(col, 0.0, 1.0);

  float alpha = mix(0.78, 1.0, clamp(t, 0.0, 1.0)) * uOpacity;
  if (uGrain > 0.5) {
    float g = hash21(gl_FragCoord.xy + mod(iTime, 64.0) * 11.0);
    alpha += (g - 0.5) * uGrainIntensity;
  }
  alpha = clamp(alpha, 0.0, 1.0);
  fragColor = vec4(col * alpha, alpha);
}
`;


export function initGradientWaves(container, options = {}) {
  const instance = new GradientWaves(container, options);
  return () => instance.destroy();
}
