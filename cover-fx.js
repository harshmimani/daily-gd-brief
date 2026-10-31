/* The Brief: living contour map behind the cover band.
   A WebGL fragment shader draws slowly drifting topographic lines (every fifth
   line brighter, like an index contour on a survey map). It leans toward the
   pointer, pauses when the cover is off screen or the tab is hidden, renders a
   single still frame for reduced-motion users, and quietly does nothing if
   WebGL is unavailable. */
(function () {
  "use strict";
  var band = document.querySelector(".masthead");
  if (!band) return;

  var canvas = document.createElement("canvas");
  canvas.className = "cover-fx";
  canvas.setAttribute("aria-hidden", "true");
  band.insertBefore(canvas, band.firstChild);

  var gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true });
  if (!gl) { canvas.remove(); return; }
  var deriv = gl.getExtension("OES_standard_derivatives");

  var VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  var FRAG = (deriv ? "#extension GL_OES_standard_derivatives : enable\n" : "") + [
    "precision mediump float;",
    "uniform vec2 r;uniform float t;uniform vec2 m;uniform vec3 ink;uniform float k;",
    // Ashima 2D simplex noise
    "vec3 pm(vec3 x){return mod(((x*34.)+1.)*x,289.);}",
    "float sn(vec2 v){const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);",
    "vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);",
    "vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod(i,289.);",
    "vec3 p=pm(pm(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));",
    "vec3 q=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);q=q*q;q=q*q;",
    "vec3 x=2.*fract(p*C.www)-1.;vec3 h=abs(x)-.5;vec3 ox=floor(x+.5);vec3 a0=x-ox;",
    "q*=1.79284291400159-.85373472095314*(a0*a0+h*h);",
    "vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;return 130.*dot(q,g);}",
    "void main(){",
    " vec2 uv=gl_FragCoord.xy/r.y;",
    " float ar=r.x/r.y;",
    " vec2 pt=uv*1.25+(m-.5)*vec2(.22,.16);",
    " float n=sn(pt*.8+vec2(t*.018,-t*.011));",
    " n+=.5*sn(pt*1.7+n*.6+vec2(-t*.013,t*.02));",
    " float h=n*5.5+t*.04;",
    " float d=abs(fract(h)-.5);",
    deriv ? " float fw=max(fwidth(h),1e-4);" : " float fw=.035;",
    // d is 0.5 on a contour line; ln is a crisp, pixel-width line
    " float ln=1.-smoothstep(fw*.5,fw*1.5,.5-d);",
    // every fifth contour is an index line, drawn brighter
    " float major=1.-step(.5,mod(floor(h+.5),5.));",
    // keep text areas calm: lines strongest top-right, fading to the left and bottom
    " float fx=smoothstep(-.1,1.,uv.x/ar);",
    " float fy=smoothstep(-.3,1.,gl_FragCoord.y/r.y);",
    " float a=ln*(.13+.3*major)*(.3+.7*fx*fy)*k;",
    // a soft glow pooled near the pointer
    " vec2 mp=vec2(m.x*ar,m.y);float glow=exp(-3.5*distance(uv,mp));",
    " a+=ln*glow*.3*k;",
    " gl_FragColor=vec4(ink*a,a);",
    "}"
  ].join("\n");

  function sh(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  }
  var vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.remove(); return; }
  var prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.remove(); return; }
  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var uR = gl.getUniformLocation(prog, "r"), uT = gl.getUniformLocation(prog, "t"),
      uM = gl.getUniformLocation(prog, "m"), uInk = gl.getUniformLocation(prog, "ink"),
      uK = gl.getUniformLocation(prog, "k");

  // Line colour comes from the --spark token, so it follows the theme.
  function readInk() {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--spark").trim() || "#5EE6A0";
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [.37, .9, .63];
  }
  var ink = readInk();
  new MutationObserver(function () { ink = readInk(); if (!running) draw(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  function resize() {
    var w = band.clientWidth, h = band.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (!running) draw();
  }

  var mouse = [0.78, 0.82], target = [0.78, 0.82];
  function point(x, y) {
    var b = band.getBoundingClientRect();
    target[0] = (x - b.left) / b.width;       // 0..1 across, 0..1 up
    target[1] = 1 - (y - b.top) / b.height;
  }
  band.addEventListener("pointermove", function (e) { point(e.clientX, e.clientY); }, { passive: true });
  band.addEventListener("touchmove", function (e) {
    if (e.touches[0]) point(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var start = performance.now(), last = 0, intro = 0;
  var visible = true, running = false, raf = 0;

  function draw(now) {
    now = now || performance.now();
    var t = (now - start) / 1000 + 40;      // offset so the first frame is already interesting
    mouse[0] += (target[0] - mouse[0]) * 0.04;
    mouse[1] += (target[1] - mouse[1]) * 0.04;
    intro = reduce.matches ? 1 : Math.min(1, intro + 0.025);
    gl.uniform2f(uR, canvas.width, canvas.height);
    gl.uniform1f(uT, reduce.matches ? 40 : t);
    gl.uniform2f(uM, mouse[0], mouse[1]);
    gl.uniform3f(uInk, ink[0], ink[1], ink[2]);
    gl.uniform1f(uK, intro * intro * (3 - 2 * intro));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function loop(now) {
    if (!running) return;
    if (now - last > 30) { draw(now); last = now; }   // ~30fps is plenty for slow drift
    raf = requestAnimationFrame(loop);
  }
  function update() {
    var should = visible && !document.hidden && !reduce.matches;
    if (should && !running) { running = true; raf = requestAnimationFrame(loop); }
    else if (!should && running) { running = false; cancelAnimationFrame(raf); draw(); }
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (es) { visible = es[0].isIntersecting; update(); }).observe(band);
  }
  document.addEventListener("visibilitychange", update);
  if (reduce.addEventListener) reduce.addEventListener("change", update);
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(band);
  else window.addEventListener("resize", resize);

  resize();
  if (reduce.matches) { intro = 1; draw(); } else update();
})();
