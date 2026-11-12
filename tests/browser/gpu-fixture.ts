import { packTouchTexture, touchLookupShader } from '../../src/viewer/touch-texture';

/** One offset array and one tick array, the way the map file holds touch histories. */
const tracks = (files: number[][]) => ({
  offsets: files.reduce((all, touches) => [...all, all[all.length - 1] + touches.length], [0]),
  ticks: files.flat(),
});

export function probeGpu(canvas: HTMLCanvasElement) {
  canvas.width = 4;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('The GPU fixture requires WebGL2.');
  function shader(type: number, source: string) {
    if (!gl) throw new Error('The GPU context was lost.');
    const value = gl.createShader(type);
    if (!value) throw new Error('Could not allocate the fixture shader.');
    gl.shaderSource(value, source);
    gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(value) ?? 'Shader compilation failed.');
    return value;
  }
  const vertex = shader(
    gl.VERTEX_SHADER,
    `#version 300 es
precision highp float;
#define attribute in
#define texture2D texture
${touchLookupShader}
in vec2 position;
uniform float cursor;
out float found;
void main(){ found=lastTouchAt(cursor); gl_Position=vec4(position,0.0,1.0); gl_PointSize=1.0; }`,
  );
  const fragment = shader(
    gl.FRAGMENT_SHADER,
    `#version 300 es
precision highp float;
in float found;
out vec4 outputColor;
void main(){ outputColor=vec4((found+1.0)/255.0,0.0,0.0,1.0); }`,
  );
  const program = gl.createProgram();
  if (!program) throw new Error('Could not allocate the fixture program.');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? 'Shader link failed.');
  gl.useProgram(program);
  const packed = packTouchTexture({
    ...tracks([[2, 5, 9], [], [0], [1, 3, 7, 10, 12]]),
    maxTextureSize: 4,
  });
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    packed.width,
    packed.height,
    0,
    gl.RED,
    gl.FLOAT,
    packed.data,
  );
  gl.uniform1i(gl.getUniformLocation(program, 'touchHistory'), 0);
  gl.uniform2f(gl.getUniformLocation(program, 'touchTextureSize'), packed.width, packed.height);
  const buffers: WebGLBuffer[] = [];
  for (const [name, components, values] of [
    ['position', 2, new Float32Array([-0.75, 0, -0.25, 0, 0.25, 0, 0.75, 0])],
    ['touchOffset', 1, packed.offsets],
    ['touchCount', 1, packed.counts],
  ] satisfies [string, number, Float32Array][]) {
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Could not allocate a fixture attribute.');
    buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
  }
  gl.viewport(0, 0, 4, 1);
  const cursors = [0, 1, 2, 5, 6, 9, 20, 5, 0];
  const result = cursors.map((cursor) => {
    gl.uniform1f(gl.getUniformLocation(program, 'cursor'), cursor);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, 4);
    const pixels = new Uint8Array(16);
    gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('GPU lookup produced a WebGL error.');
    return [pixels[0] - 1, pixels[4] - 1, pixels[8] - 1, pixels[12] - 1];
  });
  for (const buffer of buffers) gl.deleteBuffer(buffer);
  gl.deleteTexture(texture);
  gl.deleteProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return result;
}
