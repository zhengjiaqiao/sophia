// @ts-nocheck
/* 小黑猫骨架（造型照应用字标动效里的那只：大圆头、一近一远两只眼、大三角耳、细长腿、螺旋卷尾）。
 * 这里只管「生理」：四拍侧对步、着地脚钉在地上不打滑、呼吸起伏、尾巴弹簧跟随、耳朵与眨眼。
 * 「演戏」由外面的 GSAP 时间线改 st 上的参数来编排。画在 canvas 上，黑身外一圈描边，须子不描边。 */
/* 移植自 docs/specs/2026-10-06-website/catRig.js（画板定稿），逻辑不改，只改成 ES 模块导出。 */
export const CatRig = (function () {
  "use strict";
  var sm = function (t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  var lerp = function (A, B, k) { return [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k]; };
  var add = function (A, B) { return [A[0] + B[0], A[1] + B[1]]; };

  function CatRig(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.body = document.createElement("canvas");
    this.tint = document.createElement("canvas");
    this.wh = document.createElement("canvas");
    this.st = {
      x: 0, gy: 0, s: 100, fx: -1,      // 位置（设备像素）、身高、朝向（-1 朝左） i18n-exempt: 移植自画板的原注释
      moving: 0,                        // 0 站定 … 1 迈步 i18n-exempt: 移植自画板的原注释
      sit: 0, lean: 0, squash: 1,       // 坐下、重心前倾（正＝往脸的方向）、落座压缩 i18n-exempt: 移植自画板的原注释
      tilt: 0,                          // 歪头 i18n-exempt: 移植自画板的原注释
      lookX: 1, lookY: -0.15, lookK: 1, // 瞳孔看的方向与偏离量（lookK 0＝正中直视） i18n-exempt: 移植自画板的原注释
      blink: 1,                         // 时间线控制的眨眼（1 睁 … 0 闭） i18n-exempt: 移植自画板的原注释
      earL: 0, earR: 0,                 // 耳朵抽动角度 i18n-exempt: 移植自画板的原注释
      tail: 0, tailCurl: 3.8,           // 尾巴目标摆角（时间线给），尾尖卷几圈 i18n-exempt: 移植自画板的原注释
      headDip: 0, sniff: 0,             // 低头凑近、嗅（胡须与鼻头抖） i18n-exempt: 移植自画板的原注释
      pawUp: 0,                         // 近侧前爪抬起前伸（1＝拍到最远） i18n-exempt: 移植自画板的原注释
      hop: 0,                           // 往上跳（身高的倍数） i18n-exempt: 移植自画板的原注释
      earBack: 0, puff: 0, eyeWide: 0,  // 受惊：耳朵后压、尾巴炸毛、瞪眼 i18n-exempt: 移植自画板的原注释
      opacity: 1
    };
    this.phase = 0; this.clock = 0; this.lastX = null;
    this.tailA = 0; this.tailV = 0;     // 尾巴弹簧 i18n-exempt: 移植自画板的原注释
    this.breath = 0; this.autoBlink = 1; this.nextBlink = 2.5; this.blinkT = -1;
    this.sac = [0, 0]; this.nextSac = 1;
    this.col = { ink: "#1c1c1a", paper: "#ffffff", mute: "#4e4e4a", rim: "#ffffff" };
  }

  CatRig.prototype.setColors = function (c) { Object.assign(this.col, c); };

  CatRig.prototype.resize = function () {
    var r = this.c.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = d;
    this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d);
  };

  // 每帧推进「生理」：步态相位由走过的距离推（脚不打滑）、呼吸、尾巴弹簧、自动眨眼、瞳孔微动
  CatRig.prototype.step = function (dt) {
    var st = this.st, s = st.s;
    this.clock += dt;
    if (this.lastX != null) this.phase = (this.phase + Math.abs(st.x - this.lastX) / (s * 0.6)) % 1;
    this.lastX = st.x;
    this.breath = Math.sin(this.clock * Math.PI * 2 / (1.7 + st.sit * 0.6));
    // 尾巴：目标 = 时间线给的摆角 + 走路时的慢摆；身体速度带来反向的拖拽
    var walkSw = Math.sin(this.clock * 1.3) * 0.08 * (0.4 + st.moving), drag = Math.max(-0.35, Math.min(0.35, (this._vx || 0) / s * 0.12)) * st.fx;
    var target = st.tail + walkSw + drag + Math.sin(this.clock * 0.7) * 0.03 * st.sit;
    this.tailV += ((target - this.tailA) * 38 - this.tailV * 6.5) * dt;
    this.tailA += this.tailV * dt;
    this._vx = dt > 0 ? (st.x - (this._px == null ? st.x : this._px)) / dt : 0; this._px = st.x;
    // 自动眨眼：3–6 秒一次，偶尔连眨两下
    if (this.blinkT < 0 && this.clock > this.nextBlink) { this.blinkT = 0; }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      var u = this.blinkT / 0.16;
      this.autoBlink = u < 0.5 ? 1 - u * 2 : u < 1 ? (u - 0.5) * 2 : 1;
      if (u >= 1) { this.blinkT = -1; this.autoBlink = 1; this.nextBlink = this.clock + (Math.random() < 0.2 ? 0.25 : 3 + Math.random() * 3); }
    }
    // 瞳孔微动：静止时每 0.8–2 秒轻轻挪一下视线
    if (this.clock > this.nextSac) { this.sac = [(Math.random() - .5) * 0.25, (Math.random() - .5) * 0.18]; this.nextSac = this.clock + 0.8 + Math.random() * 1.2; }
  };

  CatRig.prototype.silhouette = function (g, whisk) {
    var st = this.st, col = this.col, s = st.s, ph = this.phase, moving = st.moving, clock = this.clock;
    var e = sm(st.sit), duty = 0.64, stride = 0.6 * duty * moving, br = this.breath;
    g.save();
    // 落座压缩：以脚底为原点，纵向压、横向略胀
    g.scale(st.fx * s * (1 + (1 - st.squash) * 0.6), s * st.squash);
    g.fillStyle = g.strokeStyle = col.ink; g.lineCap = "round"; g.lineJoin = "round";
    var foot = function (nx, off, lift) {
      var u = (((ph + off) % 1) + 1) % 1;
      if (u < duty) return [nx + stride * (0.5 - u / duty), 0];
      var w = (u - duty) / (1 - duty), q = sm(w);
      return [nx + stride * (-0.5 + q), -lift * Math.sin(Math.PI * w) * moving];
    };
    var ik = function (R, F, a, b, bend) {
      var dx = F[0] - R[0], dy = F[1] - R[1], d = Math.min(Math.hypot(dx, dy), a + b - 1e-4), th = Math.atan2(dy, dx);
      var al = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
      return [R[0] + a * Math.cos(th + bend * al), R[1] + a * Math.sin(th + bend * al)];
    };
    var shb = Math.sin((ph * 2 + 0.25) * Math.PI * 2) * 0.016 * moving;
    var hp = Math.sin((ph * 2 + 0.75) * Math.PI * 2) * 0.016 * moving;
    var lean = st.lean, breathRise = br * 0.006 * (0.6 + e * 0.6);
    var H = lerp([-0.3, -0.41 + hp], [-0.2, -0.2], e);
    var S = lerp([0.15 + lean * 0.35, -0.42 + shb + lean * 0.12 - breathRise], [0.08 + lean * 0.2, -0.46 - breathRise], e);
    var hb = Math.sin((ph * 2 + 0.1) * Math.PI * 2) * 0.01 * moving;
    var Hd = add(S, lerp([0.19 + lean * 0.12 + st.headDip * 0.07, -0.3 + hb + st.headDip * 0.1], [0.1, -0.33 - br * 0.003], e));
    var headT = function () { g.translate(Hd[0], Hd[1]); g.rotate(-st.tilt * 0.2 + lean * 0.25 + st.headDip * 0.28); };
    if (whisk) {
      g.lineWidth = Math.max(0.007, 1 / s); g.strokeStyle = col.mute; headT();
      var tw = br * 0.012 + Math.sin(clock * 38) * 0.018 * st.sniff;
      [[-0.14, 0.08, -1, 0.2], [0.24, 0.06, 1, 0.3]].forEach(function (w) {
        [-1, 0, 1].forEach(function (k) {
          g.beginPath(); g.moveTo(w[0], w[1] + k * 0.02);
          g.quadraticCurveTo(w[0] + w[2] * w[3] * 0.55, w[1] + k * 0.035 - 0.03 + tw, w[0] + w[2] * w[3], w[1] + k * 0.07 - 0.02 + tw * 1.6);
          g.stroke();
        });
      });
      g.restore(); return;
    }
    // 腿：站着走 ↔ 坐下（前腿直立、后腿折进臀部）
    [[0, false], [0.25, true], [0.5, false], [0.75, true]].forEach(function (L, i) {
      var off = L[0], fore = L[1], side = i < 2 ? -1 : 1, F, E, A, K, Fw;
      if (fore) {
        F = lerp(foot(0.18, off, 0.075), [0.11 + side * 0.025, 0], e);
        if (i === 3 && st.pawUp > 0) F = lerp(F, [0.6, -0.3], st.pawUp);
        E = ik(S, F, 0.23, 0.23, 1);
        g.lineWidth = 0.075; g.beginPath(); g.moveTo(S[0], S[1]); g.lineTo(E[0], E[1]); g.lineTo(F[0], F[1]); g.stroke();
      } else {
        Fw = foot(-0.3, off, 0.07); F = lerp(Fw, [-0.02 + side * 0.02, 0], e);
        A = lerp(add(Fw, [-0.05, -0.1]), [-0.2, -0.03], e); K = ik(H, A, 0.18, 0.17, -1);
        g.lineWidth = 0.08; g.beginPath(); g.moveTo(H[0], H[1]); g.lineTo(K[0], K[1]); g.lineTo(A[0], A[1]); g.lineTo(F[0], F[1]); g.stroke();
      }
      g.beginPath(); g.ellipse(F[0] + 0.02, F[1] - 0.025, 0.055, 0.035, 0, 0, Math.PI * 2); g.fill();
    });
    // 尾巴：从臀部升起，末端卷成螺旋；摆角来自弹簧（带延迟和过冲）
    (function (self) {
      var B = add(H, [-0.12, -0.1]);
      g.save(); g.translate(B[0], B[1]); g.rotate(-self.tailA - e * 0.15);
      var pts = [], bz = function (a, b, c, d, u) { return a * Math.pow(1 - u, 3) + 3 * b * u * Math.pow(1 - u, 2) + 3 * c * u * u * (1 - u) + d * u * u * u; };
      // 尾巴中段随摆角弯一点（不是一根硬棍）
      var bend = self.tailA * 0.12;
      for (var i = 0; i <= 16; i++) { var u = i / 16; pts.push([bz(0, -0.2, -0.22 + bend, -0.04 + bend * 1.6, u), bz(0, -0.03, -0.42, -0.52, u)]); }
      var P = pts[16], tx = 0.18, ty = -0.1, tl = Math.hypot(tx, ty), cx = P[0] + (-ty / tl) * 0.085, cy = P[1] + (tx / tl) * 0.085;
      var a0 = Math.atan2(P[1] - cy, P[0] - cx);
      for (var j = 1; j <= 20; j++) { var v = j / 20, r = 0.085 * (1 - 0.45 * v), an = a0 + v * st.tailCurl; pts.push([cx + r * Math.cos(an), cy + r * Math.sin(an)]); }
      g.lineWidth = 0.085 * (1 + st.puff * 0.9); g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); pts.forEach(function (q) { g.lineTo(q[0], q[1]); }); g.stroke();
      g.restore();
    })(this);
    // 身子：臀、胸两团，胸随呼吸起伏
    g.lineWidth = 0.28; g.beginPath(); g.moveTo(H[0], H[1]); g.lineTo(S[0], S[1]); g.stroke();
    g.beginPath(); g.ellipse(H[0] - 0.02, H[1] - 0.01 - e * 0.02, 0.17 + e * 0.04, 0.155 + e * 0.04, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(S[0] + 0.04, S[1] + 0.01, 0.14 + br * 0.004, 0.17 + br * 0.008, -0.3 * e, 0, Math.PI * 2); g.fill();
    g.lineWidth = 0.17; g.beginPath(); g.moveTo(S[0], S[1]); g.lineTo(Hd[0] - 0.04, Hd[1] + 0.08); g.stroke();
    // 头
    g.save(); headT();
    g.beginPath(); g.ellipse(0, 0, 0.24, 0.215, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(0.03, 0.07, 0.25, 0.15, 0, 0, Math.PI * 2); g.fill();
    g.lineWidth = 0.03;
    var ear = function (b1, tp, b2, bow, rot) {
      var bx = (b1[0] + b2[0]) / 2, by = (b1[1] + b2[1]) / 2;
      g.save(); g.translate(bx, by); g.rotate(rot); g.translate(-bx, -by);
      g.beginPath(); g.moveTo(b1[0], b1[1]);
      g.quadraticCurveTo((b1[0] + tp[0]) / 2 + bow, (b1[1] + tp[1]) / 2, tp[0], tp[1]);
      g.quadraticCurveTo((b2[0] + tp[0]) / 2 + bow * 0.5, (b2[1] + tp[1]) / 2 + 0.02, b2[0], b2[1]);
      g.closePath(); g.fill(); g.stroke(); g.restore();
    };
    ear([-0.22, -0.07], [-0.26, -0.37], [-0.08, -0.19], 0.03, st.earL - st.earBack * 0.55);
    ear([0.06, -0.2], [0.26, -0.31], [0.22, -0.06], -0.02, st.earR - st.earBack * 0.75);
    // 眼睛：一近一远；眨眼 = 时间线眨眼 × 自动眨眼；瞳孔可回到正中直视
    var bl = Math.max(0.06, Math.min(st.blink, this.autoBlink));
    var lx = st.lookX + this.sac[0] * (1 - st.moving), ly = st.lookY + this.sac[1] * (1 - st.moving), ll = Math.hypot(lx, ly) || 1;
    var kk = Math.min(1, st.lookK * ll);
    [[-0.04, 0, 0.085], [0.14, -0.05, 0.072]].forEach(function (E) {
      var ex = E[0], ey = E[1], r = E[2] * (1 + st.eyeWide * 0.22);
      g.fillStyle = col.paper; g.beginPath(); g.ellipse(ex, ey, r, Math.max(0.004, r * bl), 0, 0, Math.PI * 2); g.fill();
      if (bl < 0.35) { g.strokeStyle = col.paper; g.lineWidth = 0.012; g.beginPath(); g.moveTo(ex - r, ey); g.quadraticCurveTo(ex, ey + r * 0.35, ex + r, ey); g.stroke(); return; }
      var pr = r * 0.56 * (1 - st.eyeWide * 0.38), m = r - pr - 0.006, px = ex + (lx / ll) * m * kk, py = ey + (ly / ll) * m * kk;
      g.save(); g.beginPath(); g.ellipse(ex, ey, r, r * bl, 0, 0, Math.PI * 2); g.clip();
      g.fillStyle = col.ink; g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
      g.fillStyle = col.paper; g.beginPath(); g.arc(px + pr * 0.35, py - pr * 0.35, pr * 0.22, 0, Math.PI * 2); g.fill();
      g.restore();
    });
    var nz = Math.sin(clock * 38) * 0.006 * st.sniff; g.translate(0, nz); g.fillStyle = col.mute; g.beginPath(); g.moveTo(0.05, 0.07); g.lineTo(0.09, 0.07); g.lineTo(0.07, 0.095); g.closePath(); g.fill();
    g.restore(); g.restore();
  };

  // 画到主画布：黑身 + 八方向偏移叠出的一圈描边，再叠不描边的须子
  CatRig.prototype.render = function () {
    var st = this.st, g = this.g, s = st.s;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.c.width, this.c.height);
    if (st.opacity <= 0) return;
    var pad = Math.ceil(s * 0.35), W = Math.ceil(s * 2.6) + pad * 2, Hh = Math.ceil(s * 1.4) + pad * 2, self = this;
    [this.body, this.tint, this.wh].forEach(function (cv) { if (cv.width !== W || cv.height !== Hh) { cv.width = W; cv.height = Hh; } });
    var paint = function (cv, whisk) { var cg = cv.getContext("2d"); cg.setTransform(1, 0, 0, 1, 0, 0); cg.clearRect(0, 0, W, Hh); cg.translate(W / 2, Hh - pad); self.silhouette(cg, whisk); };
    paint(this.body, false); paint(this.wh, true);
    var tg = this.tint.getContext("2d");
    tg.setTransform(1, 0, 0, 1, 0, 0); tg.clearRect(0, 0, W, Hh); tg.globalCompositeOperation = "source-over"; tg.drawImage(this.body, 0, 0);
    tg.globalCompositeOperation = "source-in"; tg.fillStyle = this.col.rim; tg.fillRect(0, 0, W, Hh); tg.globalCompositeOperation = "source-over";
    var gx = st.x - W / 2, gy = st.gy - st.hop * s - (Hh - pad), h = Math.max(1.5, (this.dpr || 1) * 1.4);
    g.globalAlpha = st.opacity;
    for (var a = 0; a < 8; a++) g.drawImage(this.tint, gx + Math.cos(a * Math.PI / 4) * h, gy + Math.sin(a * Math.PI / 4) * h);
    g.drawImage(this.body, gx, gy); g.drawImage(this.wh, gx, gy);
    g.globalAlpha = 1;
  };

  return CatRig;
})();
