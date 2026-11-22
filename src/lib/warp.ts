// 보정된 사진을 2D 캔버스에 직접 그린다.
// (큰 사진을 CSS matrix3d로 변형하면 브라우저 GPU 타일 메모리가 부족해 검은 면이 생기므로)
// WebGL 프래그먼트 셰이더로 픽셀마다 역투영 → 근사 없이 정확한 원근 보정.
import type { Correction } from './correction';

let gl: WebGLRenderingContext | null = null;
let glCanvas: HTMLCanvasElement | null = null;
let prog: WebGLProgram | null = null;
let tex: WebGLTexture | null = null;
let texKey = ''; // 지금 텍스처에 올라간 사진 (img 요소는 재사용되므로 주소로 구분)
let glFailed = false;

const VS = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;
const FS = `precision highp float;
uniform mat3 Ci; uniform vec2 src; uniform float outH; uniform sampler2D t;
void main(){
  vec2 q = vec2(gl_FragCoord.x, outH - gl_FragCoord.y);
  vec3 s = Ci * vec3(q, 1.0);
  vec2 uv = (s.xy / s.z) / src;
  if (s.z <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  gl_FragColor = texture2D(t, uv);
}`;

function initGL(): boolean {
  if (gl) return true;
  if (glFailed) return false;
  try {
    glCanvas = document.createElement('canvas');
    gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error('no webgl');
    const sh = (type: number, src: string) => {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, src);
      gl!.compileShader(s);
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s) || 'shader');
      return s;
    };
    prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return true;
  } catch {
    glFailed = true;
    gl = null;
    return false;
  }
}

/** target 캔버스(크기 outW×outH)에 보정된 사진을 그린다. 성공하면 true */
export function renderCorrected(img: HTMLImageElement, corr: Correction, target: HTMLCanvasElement): boolean {
  const W = corr.outW, H = corr.outH;
  if (!initGL() || !gl || !glCanvas) return false;
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const maxView = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  if (img.naturalWidth > max || img.naturalHeight > max || W > maxView[0] || H > maxView[1]) return false;

  const key = `${img.currentSrc || img.src}|${img.naturalWidth}x${img.naturalHeight}`;
  if (texKey !== key) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    texKey = key;
  }
  glCanvas.width = W;
  glCanvas.height = H;
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const C = corr.Cinv; // 행 우선 → GLSL 열 우선
  gl.uniformMatrix3fv(gl.getUniformLocation(prog!, 'Ci'), false, [C[0], C[3], C[6], C[1], C[4], C[7], C[2], C[5], C[8]]);
  gl.uniform2f(gl.getUniformLocation(prog!, 'src'), img.naturalWidth, img.naturalHeight);
  gl.uniform1f(gl.getUniformLocation(prog!, 'outH'), H);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  if (target.width !== W) target.width = W;
  if (target.height !== H) target.height = H;
  const ctx = target.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(glCanvas, 0, 0);
  return true;
}

/** 텍스처 캐시 해제 (사진 교체 시) */
export function resetWarpCache() {
  texKey = '';
}
