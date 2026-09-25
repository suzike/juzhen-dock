/* 直接数像素：终端区里到底有没有"墨"。
   背景：DOM 说提示符在 (243,336) 147x19、颜色 rgb(43,33,25)，
   可肉眼看截图是一片纯色。眼睛会骗人，像素不会。
   做法：把 PNG 画进 canvas，取终端区域，统计深色像素比例，
   再降采样打一张 ASCII 密度图 —— 有字就一定能看出来。 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const target = process.env.APPDATA + '\\juzhen-dock-diag\\_desk_term.png';

const html = '<style>body{margin:0;background:#fff;font:12px monospace}'
  + 'pre{margin:0;padding:6px;white-space:pre}</style><pre id="o">…</pre><canvas id="c"></canvas>'
  + '<script>\n'
  + 'var img = new Image();\n'
  + 'img.onload = function(){\n'
  + '  var c = document.getElementById("c"), x = c.getContext("2d");\n'
  + '  c.width = img.width; c.height = img.height;\n'
  + '  x.drawImage(img, 0, 0);\n'
  + '  var L = [];\n'
  + '  var scale = img.width / 680;            /* 图是 1.5x 的窗口截图 */\n'
  + '  var px = Math.round(233 * scale), py = Math.round(328 * scale);\n'
  + '  var pw = Math.round(417 * scale), ph = Math.round(621 * scale);\n'
  + '  var d = x.getImageData(px, py, pw, ph).data;\n'
  + '  var dark = 0, n = pw * ph, minL = 255, hist = [0,0,0,0,0];\n'
  + '  for (var i = 0; i < n; i++){\n'
  + '    var r = d[i*4], g = d[i*4+1], b = d[i*4+2];\n'
  + '    var lum = Math.round(0.299*r + 0.587*g + 0.114*b);\n'
  + '    if (lum < minL) minL = lum;\n'
  + '    if (lum < 140) dark++;\n'
  + '    hist[Math.min(4, Math.floor(lum/52))]++;\n'
  + '  }\n'
  + '  /* 只降采样上半部分（提示符在最上面） */\n'
  + '  var CW = 96, CH = 26, sw = pw / CW, sh = (ph * 0.25) / CH;\n'
  + '  var art = "";\n'
  + '  for (var ry = 0; ry < CH; ry++){\n'
  + '    var line = "";\n'
  + '    for (var rx2 = 0; rx2 < CW; rx2++){\n'
  + '      var cnt = 0, tot = 0;\n'
  + '      for (var yy = Math.floor(ry*sh); yy < Math.floor((ry+1)*sh); yy++){\n'
  + '        for (var xx = Math.floor(rx2*sw); xx < Math.floor((rx2+1)*sw); xx++){\n'
  + '          var j = (yy*pw + xx)*4;\n'
  + '          var l2 = 0.299*d[j] + 0.587*d[j+1] + 0.114*d[j+2];\n'
  + '          tot++; if (l2 < 150) cnt++;\n'
  + '        }\n'
  + '      }\n'
  + '      var f = tot ? cnt/tot : 0;\n'
  + '      line += f > 0.45 ? "#" : f > 0.18 ? "+" : f > 0.05 ? "." : " ";\n'
  + '    }\n'
  + '    art += line + "\\n";\n'
  + '  }\n'
  + '  document.getElementById("o").textContent =\n'
  + '    "图 " + img.width + "x" + img.height + " · 终端区 CSS(233,328,417,621) → 像素(" + px + "," + py + "," + pw + "," + ph + ")\\n"\n'
  + '    + "深色像素(lum<140) = " + dark + " / " + n + " = " + (100*dark/n).toFixed(3) + "%  最小亮度 = " + minL + "\\n"\n'
  + '    + "亮度直方图(0-52,52-104,104-156,156-208,208-255) = " + hist.join(" / ") + "\\n"\n'
  + '    + "上半部分墨迹密度图（# 多 · + 中 · . 少）:\\n" + art;\n'
  + '};\n'
  + 'img.onerror = function(){ document.getElementById("o").textContent = "图片加载失败"; };\n'
  + 'img.src = "file:///' + target.replace(/\\/g, '/') + '";\n'
  + '<\/script>';

fs.writeFileSync(path.join(dir, '_inkcheck.html'), html, 'utf8');
const out = cp.execFileSync(chrome, ['--headless=old', '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files', '--window-size=1100,900', '--virtual-time-budget=4000',
  '--dump-dom', 'file:///' + path.join(dir, '_inkcheck.html').replace(/\\/g, '/')],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const m = out.match(/<pre id="o">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '未执行';
fs.writeFileSync(path.join(dir, '_inkcheck.txt'), res, 'utf8');
console.log(res);
