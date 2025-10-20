// Minimal WebGL1 renderer for Realtime Canvas tiles + grid
// Draws:
// - Textured quads for tile bitmaps (from 2D offscreen canvases)
// - Solid-color quads for grid lines and tile borders

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    this.failed = !this.gl;
    if (this.failed) return;

    const gl = this.gl;
    // State
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    // Programs
    this.texProg = this._createProgram(
      // vertex
      `attribute vec2 a_pos;\n`+
      `attribute vec2 a_uv;\n`+
      `uniform vec2 u_resolution;\n`+
      `uniform vec2 u_scale;\n`+
      `uniform vec2 u_translate;\n`+
      `varying vec2 v_uv;\n`+
      `void main() {\n`+
      `  vec2 screen = a_pos * u_scale + u_translate;\n`+
      `  vec2 zeroToOne = screen / u_resolution;\n`+
      `  vec2 clip = zeroToOne * 2.0 - 1.0;\n`+
      `  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);\n`+
      `  v_uv = a_uv;\n`+
      `}`,
      // fragment
      `precision mediump float;\n`+
      `uniform sampler2D u_tex;\n`+
      `varying vec2 v_uv;\n`+
      `void main() {\n`+
      `  gl_FragColor = texture2D(u_tex, v_uv);\n`+
      `}`
    );
    this.solidProg = this._createProgram(
      // vertex
      `attribute vec2 a_pos;\n`+
      `uniform vec2 u_resolution;\n`+
      `uniform vec2 u_scale;\n`+
      `uniform vec2 u_translate;\n`+
      `void main() {\n`+
      `  vec2 screen = a_pos * u_scale + u_translate;\n`+
      `  vec2 zeroToOne = screen / u_resolution;\n`+
      `  vec2 clip = zeroToOne * 2.0 - 1.0;\n`+
      `  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);\n`+
      `}`,
      // fragment
      `precision mediump float;\n`+
      `uniform vec4 u_color;\n`+
      `void main() { gl_FragColor = u_color; }`
    );

    // Lookups
    this._loc = {
      tex: {
        prog: this.texProg,
        a_pos: gl.getAttribLocation(this.texProg, 'a_pos'),
        a_uv: gl.getAttribLocation(this.texProg, 'a_uv'),
        u_resolution: gl.getUniformLocation(this.texProg, 'u_resolution'),
        u_scale: gl.getUniformLocation(this.texProg, 'u_scale'),
        u_translate: gl.getUniformLocation(this.texProg, 'u_translate'),
        u_tex: gl.getUniformLocation(this.texProg, 'u_tex'),
      },
      solid: {
        prog: this.solidProg,
        a_pos: gl.getAttribLocation(this.solidProg, 'a_pos'),
        u_resolution: gl.getUniformLocation(this.solidProg, 'u_resolution'),
        u_scale: gl.getUniformLocation(this.solidProg, 'u_scale'),
        u_translate: gl.getUniformLocation(this.solidProg, 'u_translate'),
        u_color: gl.getUniformLocation(this.solidProg, 'u_color'),
      }
    };

    // Buffers
    this._quadBuf = gl.createBuffer();
    this._quadUVBuf = gl.createBuffer();
    this._solidBuf = gl.createBuffer();

    // Defaults
    this._resolution = [canvas.width || 1, canvas.height || 1];
    this._scale = [1, 1];
    this._translate = [0, 0];
  }

  ok() { return !this.failed; }

  resize(width, height) {
    if (this.failed) return;
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    this._resolution = [width, height];
  }

  setView(scale, tx, ty, dpr) {
    if (this.failed) return;
    const s = scale * dpr;
    this._scale = [s, s];
    this._translate = [tx * dpr, ty * dpr];
  }

  begin(clear = true) {
    if (this.failed) return;
    const gl = this.gl;
    if (clear) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  // Draw a textured quad for a tile
  drawTile(tile, x, y, w, h) {
    if (this.failed) return;
    const gl = this.gl;
    const tex = this._ensureTexture(tile);
    if (!tex) return;

    const u0 = tile.pad / tile.canvas.width;
    const v0 = tile.pad / tile.canvas.height;
    const u1 = (tile.pad + w) / tile.canvas.width;
    const v1 = (tile.pad + h) / tile.canvas.height;

    const verts = new Float32Array([
      x,     y,     x + w, y,     x,     y + h,
      x + w, y,     x + w, y + h, x,     y + h,
    ]);
    const uvs = new Float32Array([
      u0, v0,  u1, v0,  u0, v1,
      u1, v0,  u1, v1,  u0, v1,
    ]);

    gl.useProgram(this._loc.tex.prog);
    gl.uniform2f(this._loc.tex.u_resolution, this._resolution[0], this._resolution[1]);
    gl.uniform2f(this._loc.tex.u_scale, this._scale[0], this._scale[1]);
    gl.uniform2f(this._loc.tex.u_translate, this._translate[0], this._translate[1]);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this._loc.tex.u_tex, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this._loc.tex.a_pos);
    gl.vertexAttribPointer(this._loc.tex.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadUVBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this._loc.tex.a_uv);
    gl.vertexAttribPointer(this._loc.tex.a_uv, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Solid-color quad in world units
  drawSolidQuad(x, y, w, h, color) {
    if (this.failed) return;
    const gl = this.gl;
    const verts = new Float32Array([
      x,     y,     x + w, y,     x,     y + h,
      x + w, y,     x + w, y + h, x,     y + h,
    ]);
    gl.useProgram(this._loc.solid.prog);
    gl.uniform2f(this._loc.solid.u_resolution, this._resolution[0], this._resolution[1]);
    gl.uniform2f(this._loc.solid.u_scale, this._scale[0], this._scale[1]);
    gl.uniform2f(this._loc.solid.u_translate, this._translate[0], this._translate[1]);
    gl.uniform4f(this._loc.solid.u_color, color[0], color[1], color[2], color[3]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._solidBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this._loc.solid.a_pos);
    gl.vertexAttribPointer(this._loc.solid.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Draw grid lines from min/max world bounds at given spacing (world units)
  drawGrid(minX, minY, maxX, maxY, spacing, thicknessWorld, color) {
    if (this.failed) return;
    const maxLines = 200;
    let drawn = 0;
    // vertical
    const x0 = Math.floor(minX / spacing) * spacing;
    for (let x = x0; x <= maxX; x += spacing) {
      const vx = x - thicknessWorld * 0.5;
      this.drawSolidQuad(vx, minY, thicknessWorld, maxY - minY, color);
      drawn++; if (drawn > maxLines) break;
    }
    // horizontal
    drawn = 0;
    const y0 = Math.floor(minY / spacing) * spacing;
    for (let y = y0; y <= maxY; y += spacing) {
      const hy = y - thicknessWorld * 0.5;
      this.drawSolidQuad(minX, hy, maxX - minX, thicknessWorld, color);
      drawn++; if (drawn > maxLines) break;
    }
  }

  // Outline rectangle using thin quads
  drawRectOutline(x, y, w, h, thicknessWorld, color) {
    const t = thicknessWorld;
    this.drawSolidQuad(x, y, w, t, color);           // top
    this.drawSolidQuad(x, y + h - t, w, t, color);   // bottom
    this.drawSolidQuad(x, y, t, h, color);           // left
    this.drawSolidQuad(x + w - t, y, t, h, color);   // right
  }

  // Ensure a WebGLTexture exists and is uploaded for the tile's canvas
  _ensureTexture(tile) {
    const gl = this.gl;
    if (!tile || !tile.canvas) return null;
    let tex = tile._glTex;
    if (!tex) {
      tex = gl.createTexture();
      tile._glTex = tex;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      tile._glTexW = 0;
      tile._glTexH = 0;
      tile._glUploadSerial = 0;
      tile.glDirty = true;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    // Upload if needed or size changed
    const w = tile.canvas.width | 0;
    const h = tile.canvas.height | 0;
    if (tile.glDirty || tile._glTexW !== w || tile._glTexH !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile.canvas);
      tile._glTexW = w; tile._glTexH = h; tile.glDirty = false; tile._glUploadSerial++;
    }
    return tex;
  }

  disposeTile(tile) {
    if (this.failed) return;
    if (!tile || !tile._glTex) return;
    try { this.gl.deleteTexture(tile._glTex); } catch {}
    tile._glTex = null; tile._glTexW = 0; tile._glTexH = 0; tile._glUploadSerial = 0;
  }

  _createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('GL shader error', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this._createShader(gl.VERTEX_SHADER, vsSource);
    const fs = this._createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('GL link error', gl.getProgramInfoLog(prog));
      try { gl.deleteProgram(prog); } catch {}
      return null;
    }
    return prog;
  }
}
