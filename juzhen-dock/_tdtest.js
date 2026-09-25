const gbk = Buffer.from('be db d5 e4 d7 d4 bc ec c3 fc c1 ee ca e4 b3 f6','hex');
const u16 = Buffer.from('5a80cd73ea81c0687d54e44e938ffa51','hex');
for (const enc of ['gbk','gb18030','utf-8']){
  try { console.log(enc.padEnd(9) + ' gbk字节 → ' + JSON.stringify(new TextDecoder(enc).decode(gbk))); }
  catch(e){ console.log(enc.padEnd(9) + ' 不支持 → ' + e.message); }
}
try { console.log('gb18030   u16字节 → ' + JSON.stringify(new TextDecoder('gb18030').decode(u16))); } catch(e){ console.log(e.message); }
console.log('utf16le   u16字节 → ' + JSON.stringify(u16.toString('utf16le')));
try { new TextDecoder('utf-8', { fatal:true }).decode(gbk); console.log('utf8 fatal 对 GBK 字节：没抛（说明不可靠）'); }
catch(e){ console.log('utf8 fatal 对 GBK 字节：抛错 ✓（可以用来判定"不是 UTF-8"）'); }
