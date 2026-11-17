import { paletteLab, parseOklch } from "./color.ts";

/**
 * The hero's living art: the app's grainy pastel mesh (components/art.tsx),
 * redrawn as a fragment shader so it can drift. Four soft colour fields wander
 * over the palette's base, folded by two layers of slow gradient noise, with
 * faint silk-like striations and a fixed film grain. Colours are the
 * `--art-<palette>-*` tokens, mixed in OKLab; dark mode can name its own
 * palette and darkens it towards the page by `--shader-veil`.
 *
 * Calm on purpose: one frame every other display frame, paused off screen and
 * in background tabs, and a single still frame under reduced motion. Without
 * WebGL the app's CSS mesh underneath (components/art.tsx) is what shows.
 */

const vertex = `
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }
`;

const fragment = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uSeed;
uniform vec3 uC[5];
uniform vec3 uVeilColor;
uniform float uVeil;

vec3 toSrgb(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  vec3 lms = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  vec3 lin = vec3(
     4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z);
  lin = clamp(lin, 0.0, 1.0);
  return mix(12.92 * lin, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
}

vec2 grad(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f);
  float b = dot(grad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(grad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(grad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float grain(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float t = uTime * 0.04;

  // Large, slow folds, then a finer one, like silk shifting.
  vec2 w = vec2(noise(p * 1.1 + vec2(uSeed, t)), noise(p * 1.1 + vec2(t + 7.3, -uSeed)));
  vec2 q = p + 0.38 * w;
  q += 0.07 * vec2(noise(q * 3.1 - t * 1.3), noise(q * 3.1 + 3.7 + t * 1.1));

  vec3 col = uC[0];
  for (int i = 1; i < 5; i++) {
    float fi = float(i);
    vec2 c = vec2(
      aspect * (0.5 + 0.44 * sin(t * (0.55 + 0.12 * fi) + fi * 1.9 + uSeed)),
      0.5 + 0.46 * cos(t * (0.47 + 0.1 * fi) + fi * 2.7 + uSeed * 0.7));
    float r = 0.42 + 0.09 * fi;
    float d = length(q - c);
    col = mix(col, uC[i], 0.92 * exp(-d * d / (r * r)));
  }

  // Faint striations along the folded field.
  float ridge = sin((q.x * 0.8 + q.y * 1.7) * 7.0 + noise(q * 1.7 + t) * 4.0);
  col.x += 0.026 * ridge;
  // OKLab mixes of opposite hues pass through grey; a little more chroma keeps the middle alive.
  col.yz *= 1.18;

  // Dark mode: darken towards the page but keep most of the colour, so it reads as dusk rather than grey.
  col.x = mix(col.x, uVeilColor.x, uVeil);
  col.yz *= 1.0 - 0.22 * uVeil;
  col.x += (grain(gl_FragCoord.xy) - 0.5) * 0.045;
  gl_FragColor = vec4(toSrgb(col), 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn(gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

export type ShaderOptions = { palette: string; darkPalette?: string; seed: number; onLive: () => void };

/** Starts the art on `canvas`, sized to `host`; returns a function that stops it. Without WebGL it does nothing. */
export function mountShader(host: HTMLElement, canvas: HTMLCanvasElement, { palette, darkPalette, seed, onLive }: ShaderOptions): () => void {
  const none = () => {};
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = matchMedia("(prefers-color-scheme: dark)");
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "low-power", preserveDrawingBuffer: false });
  if (!gl) return none;

  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return none;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return none;
  gl.useProgram(program);

  // One triangle that covers the viewport.
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl.getUniformLocation(program, name);
  const uRes = u("uRes");
  const uTime = u("uTime");
  const uColors = u("uC");
  const uVeil = u("uVeil");
  const uVeilColor = u("uVeilColor");
  gl.uniform1f(u("uSeed"), seed);

  const applyTheme = () => {
    const colors = paletteLab((darkScheme.matches && darkPalette) || palette, host);
    if (colors.length === 5) gl.uniform3fv(uColors, colors.flat());
    const style = getComputedStyle(host);
    gl.uniform1f(uVeil, Number(style.getPropertyValue("--shader-veil")) || 0);
    gl.uniform3fv(uVeilColor, parseOklch(style.getPropertyValue("--background")) ?? [0, 0, 0]);
  };
  applyTheme();

  // The art is soft, so it renders at CSS-pixel resolution (capped); the grain stays fine enough.
  const resize = () => {
    const scale = Math.min(1, 1600 / Math.max(1, host.clientWidth));
    canvas.width = Math.max(1, Math.round(host.clientWidth * scale));
    canvas.height = Math.max(1, Math.round(host.clientHeight * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uRes, canvas.width, canvas.height);
  };

  const start = performance.now() - seed * 9000;
  let visible = false;
  let raf = 0;
  let frame = 0;
  let live = false;
  const draw = (now: number) => {
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!live) {
      live = true;
      onLive();
    }
  };
  const tick = (now: number) => {
    raf = 0;
    if (!visible || document.hidden || reducedMotion.matches) return;
    // Every other frame: the motion is slow enough that 30 fps reads as smooth.
    if (frame++ % 2 === 0) draw(now);
    raf = requestAnimationFrame(tick);
  };
  const run = () => {
    if (reducedMotion.matches) draw(start + 12000);
    else if (visible && !document.hidden && !raf) raf = requestAnimationFrame(tick);
  };

  const sized = new ResizeObserver(() => {
    resize();
    draw(performance.now());
  });
  sized.observe(host);
  const seen = new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    run();
  });
  seen.observe(host);
  const retheme = () => {
    applyTheme();
    draw(performance.now());
  };
  const lost = (e: Event) => e.preventDefault();
  document.addEventListener("visibilitychange", run);
  reducedMotion.addEventListener("change", run);
  darkScheme.addEventListener("change", retheme);
  canvas.addEventListener("webglcontextlost", lost);
  return () => {
    cancelAnimationFrame(raf);
    sized.disconnect();
    seen.disconnect();
    document.removeEventListener("visibilitychange", run);
    reducedMotion.removeEventListener("change", run);
    darkScheme.removeEventListener("change", retheme);
    canvas.removeEventListener("webglcontextlost", lost);
  };
}
