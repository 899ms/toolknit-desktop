import { createIcons, icons } from 'lucide';
import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { CRYPTO_MAX_TEXT_CHARS, CRYPTO_PREFERENCES_KEY, LEGACY_ALGORITHMS, exportRsaLegacyKeyComponents, randomHex } from '../../crypto-tool-core.js';
import { tauriCorePromise, tauriEventPromise, loadTauriDialog } from '../../platform/tauri-runtime.js';
import { bindToolPageChrome, mountToolPageBackground, toolTopbarMarkup } from '../../shared/tool-page-shell.js';

const TOOLS=[
  {id:'md2',label:'MD2',group:'哈希',legacy:true},{id:'md4',label:'MD4',group:'哈希',legacy:true},{id:'md5',label:'MD5',group:'哈希',legacy:true},
  {id:'sha',label:'SHA 全家桶',group:'哈希'},{id:'sm3',label:'SM3',group:'哈希'},{id:'blake',label:'BLAKE 全家桶',group:'哈希'},{id:'file-hash',label:'File Hash',group:'哈希'},
  {id:'hmac-md5',label:'HMAC-MD5',group:'HMAC',legacy:true},
  {id:'aes',label:'AES',group:'对称加密'},{id:'des',label:'DES',group:'对称加密',legacy:true},{id:'3des',label:'3DES',group:'对称加密',legacy:true},{id:'sm4',label:'SM4',group:'对称加密'},
  {id:'rc4',label:'RC4',group:'对称加密',legacy:true},{id:'chacha20',label:'ChaCha20',group:'对称加密'},{id:'trivium',label:'Trivium',group:'对称加密'},
  {id:'rsa',label:'RSA',group:'非对称加密'},{id:'sm2',label:'SM2',group:'非对称加密'}
];
const HASH_IDS=new Set(['md2','md4','md5','sha','sm3','blake','hmac-md5']);
const SYMMETRIC_IDS=new Set(['aes','des','3des','sm4','rc4','chacha20','trivium']);

const CRYPTO_ERROR_MESSAGES={
  'crypto:input-too-large':'输入内容超过 2 MB 限制',
  'crypto:invalid-hex':'Hex 格式无效，请使用成对的十六进制字符',
  'crypto:invalid-base64':'Base64 格式无效',
  'crypto:invalid-utf8-output':'解密结果不是有效的 UTF-8 文本，请检查密钥、IV 和输出格式',
  'crypto:key-required':'请输入密钥',
  'crypto:invalid-mode':'当前算法不支持所选模式',
  'crypto:invalid-padding':'当前算法不支持所选填充方式',
  'crypto:invalid-operation':'当前加密操作无效',
  'crypto:invalid-scheme':'当前 RSA 加密方案无效',
  'crypto:block-length':'输入长度必须是分组大小的整数倍',
  'crypto:invalid-pem':'RSA 密钥必须使用标准 PEM 格式',
  'crypto:rsa-size':'不支持所选 RSA 密钥位数',
  'crypto:rsa-public-key':'RSA 公钥格式无效',
  'crypto:rsa-private-key':'RSA 私钥格式无效',
  'crypto:rsa-ciphertext':'RSA 密文不是有效的 Base64',
  'crypto:rsa-encrypt':'RSA 加密失败，请检查明文长度和公钥',
  'crypto:rsa-decrypt':'RSA 解密失败，请检查密文、私钥和加密方案',
  'crypto:rsa-utf8':'RSA 解密结果不是有效的 UTF-8 文本',
  'crypto:rsa-platform':'PKCS#1 v1.5 兼容模式仅支持 Windows 桌面版',
  'crypto:rsa-provider':'Windows 密码服务当前不可用',
  'file-hash:no-algorithm':'请至少选择一种摘要算法',
  'file-hash:unsupported-algorithm':'包含不支持的文件摘要算法',
  'file-hash:invalid-hmac-key':'请输入 HMAC-SHA256 密钥',
  'file-hash:invalid-input':'所选文件无效或已不存在',
  'file-hash:read-failed':'读取文件失败',
  'tkaes:password-required':'请输入文件密码',
  'tkaes:invalid-container':'所选文件不是有效的 ToolKnit 加密容器',
  'tkaes:unsupported-version':'该加密容器版本暂不受支持',
  'tkaes:authentication-failed':'密码错误或文件已经损坏',
  'tkaes:trailing-data':'加密容器末尾存在异常数据',
  'tkaes:kdf-params':'加密容器的密钥派生参数无效',
  'crypto:rsa-oaep-size':'RSA-OAEP / SHA-256 不支持 512 位密钥，请选择至少 1024 位',
  'tool-operation:cancelled':'操作已取消'
};

function describeCryptoError(error){
  const raw=String(error?.message||error||'').trim();
  if(CRYPTO_ERROR_MESSAGES[raw])return CRYPTO_ERROR_MESSAGES[raw];
  const length=/^crypto:(key|iv)-length:([\d|]+)$/.exec(raw);
  if(length)return `${length[1]==='key'?'密钥':'IV / Nonce'}长度必须为 ${length[2].split('|').join('、')} 字节`;
  return raw.replace(/^(crypto|file-hash|tkaes|tool-operation):/,'')||'未知错误';
}

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);}
function navMarkup(){let group='';return TOOLS.map(tool=>{const heading=tool.group!==group?`<div class="crypto-nav-group">${escapeHtml(group=tool.group)}</div>`:'';return `${heading}<button type="button" data-crypto-tool="${tool.id}" class="${tool.id==='sha'?'is-active':''}"><i data-lucide="${tool.group==='哈希'?'hash':tool.group==='HMAC'?'key-round':tool.group==='对称加密'?'lock-keyhole':'key-square'}"></i><span>${tool.label}</span>${tool.legacy?'<em>LEGACY</em>':''}</button>`;}).join('');}

export function initCryptoTool({overlay,notify=message=>window.showToast?.(message)}){
  if(!overlay)throw new Error('crypto:missing-overlay');
  const invoke = async (...args) => (await tauriCorePromise).invoke(...args);
  const listen = async (...args) => (await tauriEventPromise).listen(...args);
  const open = async (...args) => (await loadTauriDialog()).open(...args);
  overlay.innerHTML=`<div class="tool-page-v2-shell crypto-shell">${toolTopbarMarkup({tag:'DEVELOPER TOOLS · CRYPTO WORKBENCH',title:'Hash & Crypto',closeAttr:'data-crypto-close'})}<main class="tool-page-v2-body crypto-main"><aside class="tool-page-v2-rail crypto-sidebar"><div class="tool-page-v2-rail-kicker">HASH &amp; CRYPTO</div><h1>安全算法<br>工作台</h1><p>从摘要、编码到加密和密钥生成，所有运算都在本机完成。</p><div class="tool-page-v2-rail-note"><span>LOCAL ONLY</span><strong>密钥、密码和结果不会保存，关闭页面立即清除。</strong></div><div class="tool-page-v2-steps"><div class="is-active"><b>01</b><span><strong>选择算法</strong><small>按哈希、对称或非对称分类。</small></span></div><div><b>02</b><span><strong>配置参数</strong><small>严格校验字节长度和编码格式。</small></span></div><div><b>03</b><span><strong>执行并清理</strong><small>独立线程计算，支持取消。</small></span></div></div><div class="crypto-sidebar-index"><div class="crypto-sidebar-head"><span>17 MODULES</span><strong>算法导航</strong></div><nav>${navMarkup()}</nav></div></aside><section class="crypto-workspace"><div class="crypto-workspace-head"><div><span data-crypto-group>HASH / MODERN</span><h1 data-crypto-title>SHA 全家桶</h1><p data-crypto-desc>输入内容后在独立线程中实时计算摘要。</p></div><div class="crypto-status" data-crypto-status><i data-lucide="cpu"></i><span>本地就绪</span></div></div><div class="crypto-legacy-warning" data-crypto-warning hidden><i data-lucide="triangle-alert"></i><div><strong data-crypto-warning-title>仅用于兼容验证</strong><p data-crypto-warning-desc>该算法已不适合密码保护、签名或新系统设计。</p></div></div><div class="crypto-panel" data-crypto-panel></div><aside class="crypto-session-log"><div><span>SESSION LOG</span><strong>本次操作</strong></div><ol data-crypto-log><li><i></i><span>尚未执行任何操作</span></li></ol></aside></section></main></div>`;
  createIcons({icons});
  const shell=overlay.querySelector('.tool-page-v2-shell');
  shell.classList.add('tool-page-v2-light');
  const lifecycle=createLifecycleScope();
  let backgroundDispose=null;const q=s=>overlay.querySelector(s);let active='sha';let worker=null;let workerBusy=false;let taskId=0;let viewId=0;let timer=0;let filePath='';let fileOperationId='';let logs=[];let unlisten=[];let listenerId=0;let disposed=false;
  lifecycle.use(bindToolPageChrome(shell,()=>api.close()));
  const prefs=(()=>{try{return JSON.parse(localStorage.getItem(CRYPTO_PREFERENCES_KEY)||'{}');}catch{return {};}})();
  async function outputRoot() { return (await invoke('get_output_root')) || (await invoke('get_default_output_root')); }
  function savePrefs(extra={}){Object.assign(prefs,extra);localStorage.setItem(CRYPTO_PREFERENCES_KEY,JSON.stringify(prefs));}
  function ensureWorker(){if(worker)return;worker=new Worker(new URL('./crypto-tool-worker.js',import.meta.url),{type:'module'});worker.addEventListener('message',event=>{if(event.data?.taskId!==taskId)return;workerBusy=false;setBusy(false);if(event.data.ok){const result=event.data.result;if(result&&typeof result==='object'&&('publicKey'in result)){const publicField=q('[data-public-key]');const privateField=q('[data-private-key]');if(publicField&&privateField){publicField.value=result.publicKey;privateField.value=result.privateKey;addLog(active,true);}}else{const output=q('[data-crypto-output]');if(output){output.value=String(result);addLog(active,true);}}}else{showError(event.data.error);addLog(active,false);}});}
  function invalidateWorker(){clearTimeout(timer);timer=0;taskId+=1;worker?.terminate();worker=null;workerBusy=false;}
  function post(type,payload){if(Object.values(payload||{}).some(value=>typeof value==='string'&&value.length>CRYPTO_MAX_TEXT_CHARS)){showError('crypto:input-too-large');return;}if(workerBusy)invalidateWorker();ensureWorker();setBusy(true);workerBusy=true;const requestId=++taskId;worker.postMessage({taskId:requestId,type,payload});}
  function setBusy(value,text=value?'正在计算...':'本地就绪'){const status=q('[data-crypto-status]');if(!status)return;status.classList.toggle('is-busy',value);const label=status.querySelector('span');if(label)label.textContent=text;}
  function showError(error){const text=describeCryptoError(error);notify(`操作失败：${text}`);setBusy(false,text==='操作已取消'?'操作已取消':'需要检查参数');}
  function addLog(method,ok){logs.unshift({method,time:new Date().toLocaleTimeString(),ok});logs=logs.slice(0,8);q('[data-crypto-log]').innerHTML=logs.map(item=>`<li><i class="${item.ok?'is-ok':'is-error'}"></i><span>${escapeHtml(item.method)}</span><time>${item.time}</time></li>`).join('');}

  function closeSelectMenus(except=null){
    overlay.querySelectorAll('.crypto-select').forEach(control=>{
      if(control===except)return;
      control.querySelector('[data-crypto-select-menu]')?.setAttribute('hidden','');
      control.querySelector('[data-crypto-select-trigger]')?.setAttribute('aria-expanded','false');
    });
  }

  function syncSelectControl(select){
    const control=select.nextElementSibling;
    if(!control?.classList.contains('crypto-select'))return;
    const selected=select.options[select.selectedIndex]||select.options[0];
    control.querySelector('[data-crypto-select-label]').textContent=selected?.textContent||'';
    control.querySelectorAll('[data-crypto-select-value]').forEach(button=>{
      const isSelected=button.dataset.cryptoSelectValue===select.value;
      button.classList.toggle('is-selected',isSelected);
      button.setAttribute('aria-selected',String(isSelected));
    });
  }

  function enhanceSelects(){
    overlay.querySelectorAll('.crypto-panel select[data-opt]').forEach((select,index)=>{
      if(select.dataset.cryptoSelectReady==='1')return;
      select.dataset.cryptoSelectReady='1';
      select.hidden=true;
      const control=document.createElement('div');
      control.className='crypto-select';
      const listboxId=`crypto-select-${active}-${index}`;
      control.innerHTML=`<button class="crypto-select-trigger" type="button" data-crypto-select-trigger aria-haspopup="listbox" aria-expanded="false" aria-controls="${listboxId}"><span data-crypto-select-label></span><i data-lucide="chevron-down"></i></button><div class="crypto-select-menu" id="${listboxId}" data-crypto-select-menu role="listbox" hidden>${Array.from(select.options).map(item=>`<button type="button" role="option" data-crypto-select-value="${escapeHtml(item.value)}" aria-selected="false">${escapeHtml(item.textContent)}</button>`).join('')}</div>`;
      select.insertAdjacentElement('afterend',control);
      syncSelectControl(select);
    });
    createIcons({icons});
  }

  function warningState(){
    if(LEGACY_ALGORITHMS.has(active))return {
      title:'仅用于兼容验证',
      description:'该算法已不适合密码保护、签名或新系统设计。'
    };
    if(active==='sha'&&option('variant','sha256')==='sha1')return {
      title:'SHA-1 仅用于兼容验证',
      description:'SHA-1 已不适合签名、证书或安全校验；新场景请使用 SHA-256 或更高版本。'
    };
    if(active==='rsa'){
      const scheme=option('scheme','oaep');
      const size=Number(option('keySize','2048'));
      if(scheme==='pkcs1'||size<2048)return {
        title:'当前 RSA 配置仅用于兼容验证',
        description:scheme==='pkcs1'
          ?'PKCS#1 v1.5 仅用于兼容旧系统；新场景应使用 RSA-OAEP，并选择至少 2048 位密钥。'
          :'RSA 512/1024 位密钥已不满足现代安全要求，请选择 2048 或 4096 位。'
      };
    }
    if(active==='file-hash'){
      const selected=Array.from(overlay.querySelectorAll('.crypto-hash-checks input:checked')).map(input=>input.value);
      if(selected.includes('md5')||selected.includes('sha1'))return {
        title:'已选择旧摘要算法',
        description:'MD5 与 SHA-1 只适合兼容性或普通文件一致性检查，不适合密码保护、签名或安全校验。'
      };
    }
    return null;
  }

  function updateWarning(){
    const warning=q('[data-crypto-warning]');
    const state=warningState();
    warning.hidden=!state;
    if(!state)return;
    q('[data-crypto-warning-title]').textContent=state.title;
    q('[data-crypto-warning-desc]').textContent=state.description;
  }
  function optionsMarkup(){return `<label><span>输出大小写</span><select data-opt="upper"><option value="false">小写</option><option value="true">大写</option></select></label>`;}
  function hashMarkup(){const selector=active==='sha'?`<label><span>算法</span><select data-opt="variant"><option value="sha1">SHA-1</option><option value="sha224">SHA-224</option><option value="sha256" selected>SHA-256</option><option value="sha384">SHA-384</option><option value="sha512">SHA-512</option><option value="sha3-256">SHA3-256</option><option value="sha3-512">SHA3-512</option></select></label>`:active==='blake'?`<label><span>算法</span><select data-opt="variant"><option value="blake2b-512">BLAKE2b-512</option><option value="blake2s-256">BLAKE2s-256</option><option value="blake3-256">BLAKE3-256</option></select></label>`:'';const short=['md4','md5'].includes(active)?`<label><span>摘要长度</span><select data-opt="short"><option value="false">完整 32 位</option><option value="true">中间 16 位</option></select></label>`:'';const key=active==='hmac-md5'?`<label class="crypto-field"><span>密钥</span><input type="password" data-crypto-key autocomplete="new-password" placeholder="不会保存"><select data-opt="keyFormat"><option value="text">文本</option><option value="hex">Hex</option></select></label>`:'';return `<div class="crypto-config-row">${selector}${short}${optionsMarkup()}</div>${key}<div class="crypto-io-grid"><label class="crypto-io"><span>输入文本</span><textarea data-crypto-input placeholder="输入内容后实时计算" spellcheck="false"></textarea></label><label class="crypto-io"><span>摘要结果 <button type="button" data-copy><i data-lucide="copy"></i></button></span><textarea data-crypto-output readonly placeholder="等待输入"></textarea></label></div><div class="crypto-actions"><button type="button" data-clear><i data-lucide="eraser"></i><span>清空</span></button><button class="is-primary" type="button" data-run><i data-lucide="play"></i><span>立即计算</span></button></div>`;}
  function formats(forOutput=false){return `<select data-opt="${forOutput?'outputFormat':'inputFormat'}">${forOutput?'<option value="base64">Base64</option><option value="hex">Hex</option><option value="text">文本</option>':'<option value="text">文本</option><option value="hex">Hex</option><option value="base64">Base64</option>'}</select>`;}
  function symmetricMarkup(){const needsIv=!['rc4'].includes(active);const keyBytes={aes:'16 / 24 / 32 字节',des:'8 字节', '3des':'24 字节',sm4:'16 字节',rc4:'任意非空',chacha20:'32 字节',trivium:'10 字节'}[active];const ivBytes={aes:'16 字节',des:'8 字节','3des':'8 字节',sm4:'16 字节',chacha20:'12 字节',trivium:'10 字节'}[active];const paddingOptions=active==='sm4'?'<option value="pkcs7">PKCS7</option><option value="nopadding">No Padding</option>':'<option value="pkcs7">PKCS7</option><option value="zero">Zero Padding</option><option value="ansix923">ANSI X9.23</option><option value="iso10126">ISO 10126</option><option value="nopadding">No Padding</option>';const modes=['aes','des','3des','sm4'].includes(active)?`<label><span>模式</span><select data-opt="mode"><option>CBC</option><option>ECB</option>${active==='sm4'?'':'<option>CTR</option><option>OFB</option><option>CFB</option>'}</select></label><label><span>填充</span><select data-opt="padding">${paddingOptions}</select></label>`:'';const aesMode=active==='aes'?`<div class="crypto-mode-tabs"><button class="is-active" data-aes-mode="text">文本</button><button data-aes-mode="file">文件</button></div>`:'';return `${aesMode}<div data-symmetric-text><div class="crypto-config-row"><div class="crypto-operation"><button class="is-active" data-operation="encrypt">加密</button><button data-operation="decrypt">解密</button></div>${modes}</div><div class="crypto-secret-grid"><label class="crypto-field"><span>密钥 · ${keyBytes}</span><div><input type="password" data-crypto-key autocomplete="new-password" placeholder="Hex 或文本，严格校验长度"><select data-opt="keyFormat"><option value="hex">Hex</option><option value="text">文本</option></select><button title="安全随机生成" data-random="key"><i data-lucide="dices"></i></button></div></label>${needsIv?`<label class="crypto-field"><span>IV / Nonce · ${ivBytes}</span><div><input type="text" data-crypto-iv autocomplete="off"><select data-opt="ivFormat"><option value="hex">Hex</option><option value="text">文本</option></select><button title="安全随机生成" data-random="iv"><i data-lucide="dices"></i></button></div></label>`:''}</div><div class="crypto-io-grid"><label class="crypto-io"><span>输入 ${formats(false)}</span><textarea data-crypto-input spellcheck="false"></textarea></label><label class="crypto-io"><span>输出 ${formats(true)} <button type="button" data-copy><i data-lucide="copy"></i></button></span><textarea data-crypto-output readonly></textarea></label></div><div class="crypto-actions"><button type="button" data-clear><i data-lucide="eraser"></i><span>清空</span></button><button class="is-primary" type="button" data-run><i data-lucide="lock-keyhole"></i><span>执行</span></button></div></div>${active==='aes'?fileAesMarkup():''}`;}
  function fileAesMarkup(){return `<div class="crypto-file-mode" data-symmetric-file hidden><button class="crypto-file-picker" data-pick-crypto-file><i data-lucide="file-key-2"></i><span><strong data-file-name>选择需要加密或解密的文件</strong><small>使用 Argon2id + AES-256-GCM 分块认证容器</small></span></button><div class="crypto-operation"><button class="is-active" data-file-operation="encrypt">加密为 .tkaes</button><button data-file-operation="decrypt">解密容器</button></div><div class="crypto-secret-grid"><label class="crypto-field"><span>文件密码</span><input type="password" data-file-password autocomplete="new-password"></label><label class="crypto-field" data-file-confirm-wrap><span>再次输入密码</span><input type="password" data-file-password-confirm autocomplete="new-password"></label></div><div class="crypto-file-progress"><span><i data-file-progress></i></span><small data-file-progress-text>等待开始</small></div><div class="crypto-actions"><button type="button" data-file-cancel disabled><i data-lucide="x"></i><span>取消</span></button><button class="is-primary" type="button" data-file-run><i data-lucide="shield-check"></i><span>开始文件处理</span></button></div></div>`;}
  function asymmetricMarkup(){const rsa=active==='rsa';return `<div class="crypto-config-row"><div class="crypto-operation"><button class="is-active" data-operation="encrypt">加密</button><button data-operation="decrypt">解密</button></div>${rsa?`<label><span>方案</span><select data-opt="scheme"><option value="oaep">RSA-OAEP / SHA-256</option><option value="pkcs1">PKCS#1 v1.5 · 兼容</option></select></label><label><span>密钥位数</span><select data-opt="keySize"><option>2048</option><option>4096</option><option>1024</option><option>512</option></select></label>`:`<label><span>密文顺序</span><select data-opt="sm2Mode"><option value="1">C1C3C2 · 标准</option><option value="0">C1C2C3 · 兼容</option></select></label>`}<button class="crypto-generate-key" data-generate-key><i data-lucide="key-round"></i><span>生成密钥对</span></button></div><div class="crypto-key-grid"><label><span>公钥</span><textarea data-public-key spellcheck="false"></textarea></label><label><span>私钥 · 不会保存</span><textarea data-private-key spellcheck="false"></textarea></label></div><div class="crypto-io-grid"><label class="crypto-io"><span>输入</span><textarea data-crypto-input spellcheck="false"></textarea></label><label class="crypto-io"><span>输出 <button type="button" data-copy><i data-lucide="copy"></i></button></span><textarea data-crypto-output readonly></textarea></label></div><div class="crypto-actions"><button type="button" data-clear><i data-lucide="eraser"></i><span>清空敏感内容</span></button><button class="is-primary" type="button" data-run><i data-lucide="play"></i><span>执行</span></button></div>`;}
  function fileHashMarkup(){return `<div class="crypto-file-hash"><button class="crypto-file-picker" data-pick-crypto-file><i data-lucide="file-search"></i><span><strong data-file-name>选择文件</strong><small>流式读取，不会一次载入内存</small></span></button><div class="crypto-hash-checks"><label><input type="checkbox" value="md5" checked>MD5</label><label><input type="checkbox" value="sha1" checked>SHA-1</label><label><input type="checkbox" value="sha256" checked>SHA-256</label><label><input type="checkbox" value="sha512">SHA-512</label><label><input type="checkbox" value="hmac-sha256">HMAC-SHA256</label></div><label class="crypto-field" data-file-hmac-key hidden><span>HMAC 密钥</span><input type="password" autocomplete="new-password"></label><div class="crypto-file-progress"><span><i data-file-progress></i></span><small data-file-progress-text>等待开始</small></div><label class="crypto-io crypto-file-results"><span>摘要结果 <button type="button" data-copy><i data-lucide="copy"></i></button></span><textarea data-crypto-output readonly></textarea></label><div class="crypto-actions"><button type="button" data-file-cancel disabled><i data-lucide="x"></i><span>取消</span></button><button class="is-primary" data-file-run><i data-lucide="play"></i><span>开始计算</span></button></div></div>`;}
  function render(){viewId+=1;invalidateWorker();const tool=TOOLS.find(item=>item.id===active);q('[data-crypto-title]').textContent=tool.label;q('[data-crypto-group]').textContent=`${tool.group.toUpperCase()} / ${tool.legacy?'LEGACY':'LOCAL'}`;q('[data-crypto-desc]').textContent=tool.id==='file-hash'?'一次流式扫描生成多种文件摘要。':SYMMETRIC_IDS.has(active)?'严格按字节长度校验密钥与 IV，不会自动补零或截断。':tool.group==='非对称加密'?'密钥仅存在当前页面，关闭工具立即清除。':'输入内容后在独立线程中实时计算结果。';q('[data-crypto-panel]').innerHTML=active==='file-hash'?fileHashMarkup():HASH_IDS.has(active)?hashMarkup():SYMMETRIC_IDS.has(active)?symmetricMarkup():asymmetricMarkup();applyPrefs();enhanceSelects();updateWarning();filePath='';setBusy(false);}
  function applyPrefs(){q('[data-opt="upper"]')&&(q('[data-opt="upper"]').value=String(prefs.upper||false));q('[data-opt="variant"]')&&prefs[`${active}Variant`]&&(q('[data-opt="variant"]').value=prefs[`${active}Variant`]);}
  function option(name,fallback=''){return q(`[data-opt="${name}"]`)?.value??fallback;}
  function algorithm(){return active==='sha'||active==='blake'?option('variant'):active;}
  function payload(){return {algorithm:algorithm(),operation:q('[data-operation].is-active')?.dataset.operation||'encrypt',input:q('[data-crypto-input]')?.value||'',key:q('[data-crypto-key]')?.value||'',iv:q('[data-crypto-iv]')?.value||'',publicKey:q('[data-public-key]')?.value||'',privateKey:q('[data-private-key]')?.value||'',upper:option('upper')==='true',short:option('short')==='true',keyFormat:option('keyFormat','hex'),ivFormat:option('ivFormat','hex'),inputFormat:option('inputFormat','text'),outputFormat:option('outputFormat','base64'),mode:option('mode','CBC'),padding:option('padding','pkcs7'),scheme:option('scheme','oaep'),mode:active==='sm2'?Number(option('sm2Mode','1')):option('mode','CBC')};}
  function run(){const data=payload();if(active==='rsa'&&data.scheme==='pkcs1'){void runNativeRsa(data);return;}post('run',data);}
  function schedule(){if(!HASH_IDS.has(active))return;clearTimeout(timer);timer=setTimeout(()=>run(),160);}
  function clearSecrets(){for(const selector of ['[data-crypto-input]','[data-crypto-output]','[data-crypto-key]','[data-crypto-iv]','[data-public-key]','[data-private-key]','[data-file-password]','[data-file-password-confirm]']){const field=q(selector);if(field)field.value='';}}
  async function generateKeys(){const scheme=option('scheme','oaep');const size=Number(option('keySize','2048'));if(active==='rsa'&&scheme==='oaep'&&size===512){showError('crypto:rsa-oaep-size');return;}post(active==='rsa'?'generate-rsa':'generate-sm2',active==='rsa'?{size,scheme}:{})}
  async function runNativeRsa(data){const requestView=viewId;let key=null;setBusy(true);try{if(data.input.length>CRYPTO_MAX_TEXT_CHARS)throw new Error('crypto:input-too-large');key=await exportRsaLegacyKeyComponents(data.operation,data.publicKey,data.privateKey);if(requestView!==viewId)return;const result=await invoke('rsa_legacy_operation',{operation:data.operation,input:data.input,key});if(requestView!==viewId)return;const output=q('[data-crypto-output]');if(output)output.value=result;addLog('RSA PKCS#1 v1.5',true);}catch(error){if(requestView===viewId){showError(error);addLog('RSA PKCS#1 v1.5',false);}}finally{if(key)Object.keys(key).forEach(field=>{key[field]='';});if(requestView===viewId)setBusy(false);}}
  function keyBytes(){return {aes:[16,24,32],des:[8],'3des':[24],sm4:[16],chacha20:[32],trivium:[10]}[active]||[16];}function ivBytes(){return {aes:16,des:8,'3des':8,sm4:16,chacha20:12,trivium:10}[active]||8;}
  async function chooseFile(){const path=await open({multiple:false,filters:active==='aes'&&q('[data-file-operation="decrypt"]')?.classList.contains('is-active')?[{name:'ToolKnit AES',extensions:['tkaes']}]:undefined});if(typeof path==='string'){filePath=path;q('[data-file-name]').textContent=path.split(/[\\/]/).pop();}}
  async function runFile(){if(!filePath)return notify('请先选择文件。');if(fileOperationId)return;const operationId=crypto.randomUUID();const requestView=viewId;const operationType=active==='file-hash'?'File Hash':'AES File';fileOperationId=operationId;const cancel=q('[data-file-cancel]');const runButton=q('[data-file-run]');cancel.disabled=false;runButton.disabled=true;try{if(active==='file-hash'){const algorithms=Array.from(overlay.querySelectorAll('.crypto-hash-checks input:checked')).map(input=>input.value);if(!algorithms.length)throw new Error('file-hash:no-algorithm');const result=await invoke('hash_file',{inputPath:filePath,algorithms,hmacKey:q('[data-file-hmac-key] input')?.value||null,operationId});if(requestView!==viewId||fileOperationId!==operationId)return;q('[data-crypto-output]').value=Object.entries(result.digests||{}).map(([key,value])=>`${key.toUpperCase()}\n${value}`).join('\n\n');addLog('File Hash',true);}else{const decrypt=q('[data-file-operation="decrypt"]')?.classList.contains('is-active');const password=q('[data-file-password]').value;if(!password)throw new Error('tkaes:password-required');if(!decrypt&&password!==q('[data-file-password-confirm]').value)throw new Error('两次密码不一致');const root=await outputRoot();if(requestView!==viewId||fileOperationId!==operationId)return;const command=decrypt?'decrypt_tkaes_file':'encrypt_tkaes_file';const result=await invoke(command,{inputPath:filePath,outputDir:`${root}\\Encrypted`,password,operationId});if(requestView!==viewId||fileOperationId!==operationId)return;notify(`文件处理完成：${result.output_path||result.outputPath}`);addLog(command,true);q('[data-file-password]').value='';q('[data-file-password-confirm]')&&(q('[data-file-password-confirm]').value='');}}catch(error){if(requestView===viewId&&fileOperationId===operationId){const cancelled=String(error?.message||error).includes('tool-operation:cancelled');if(!cancelled)showError(error);else setBusy(false,'操作已取消');addLog(operationType,false);}}finally{if(fileOperationId===operationId)fileOperationId='';if(requestView===viewId){cancel.disabled=true;runButton.disabled=false;}}}
  async function cancelFile(){const operationId=fileOperationId;if(!operationId)return;await invoke('cancel_tool_operation',{operationId}).catch(()=>{});}
  lifecycle.event(overlay,'click',event=>{
    const selectTrigger=event.target.closest('[data-crypto-select-trigger]');
    if(selectTrigger){
      event.preventDefault();
      const control=selectTrigger.closest('.crypto-select');
      const menu=control.querySelector('[data-crypto-select-menu]');
      const willOpen=menu.hidden;
      closeSelectMenus(control);
      menu.hidden=!willOpen;
      selectTrigger.setAttribute('aria-expanded',String(willOpen));
      return;
    }
    const selectOption=event.target.closest('[data-crypto-select-value]');
    if(selectOption){
      event.preventDefault();
      const control=selectOption.closest('.crypto-select');
      const select=control.previousElementSibling;
      select.value=selectOption.dataset.cryptoSelectValue;
      syncSelectControl(select);
      closeSelectMenus();
      select.dispatchEvent(new Event('input',{bubbles:true}));
      select.dispatchEvent(new Event('change',{bubbles:true}));
      control.querySelector('[data-crypto-select-trigger]').focus();
      return;
    }
    if(!event.target.closest('.crypto-select'))closeSelectMenus();
    const nav=event.target.closest('[data-crypto-tool]');
    if(nav){const next=nav.dataset.cryptoTool;if(next===active)return;if(fileOperationId){void cancelFile();fileOperationId='';}active=next;overlay.querySelectorAll('[data-crypto-tool]').forEach(button=>button.classList.toggle('is-active',button===nav));render();return;}
    const operation=event.target.closest('[data-operation]');
    if(operation){q('[data-operation].is-active')?.classList.remove('is-active');operation.classList.add('is-active');}
    const fileOp=event.target.closest('[data-file-operation]');
    if(fileOp){q('[data-file-operation].is-active')?.classList.remove('is-active');fileOp.classList.add('is-active');q('[data-file-confirm-wrap]')&&(q('[data-file-confirm-wrap]').hidden=fileOp.dataset.fileOperation==='decrypt');}
    const aesMode=event.target.closest('[data-aes-mode]');
    if(aesMode){overlay.querySelectorAll('[data-aes-mode]').forEach(button=>button.classList.toggle('is-active',button===aesMode));q('[data-symmetric-text]').hidden=aesMode.dataset.aesMode==='file';q('[data-symmetric-file]').hidden=aesMode.dataset.aesMode!=='file';}
    if(event.target.closest('[data-run]'))run();
    if(event.target.closest('[data-clear]')){invalidateWorker();clearSecrets();setBusy(false);}
    if(event.target.closest('[data-copy]'))navigator.clipboard.writeText(q('[data-crypto-output]')?.value||'').then(()=>notify('已复制结果')).catch(()=>notify('复制失败，请重试'));
    if(event.target.closest('[data-generate-key]'))void generateKeys();
    const random=event.target.closest('[data-random]')?.dataset.random;
    if(random){const field=random==='key'?q('[data-crypto-key]'):q('[data-crypto-iv]');field.value=randomHex(random==='key'?keyBytes()[0]:ivBytes());}
    if(event.target.closest('[data-pick-crypto-file]'))void chooseFile();
    if(event.target.closest('[data-file-run]'))void runFile();
    if(event.target.closest('[data-file-cancel]'))void cancelFile();
  });
  lifecycle.event(overlay,'input',event=>{
    if(event.target.matches('[data-crypto-input],[data-crypto-key]')&&HASH_IDS.has(active))schedule();
    if(event.target.matches('[data-opt]')){
      const name=event.target.dataset.opt;
      if(['upper','variant'].includes(name)){
        savePrefs(name==='variant'?{[`${active}Variant`]:event.target.value}:{upper:event.target.value==='true'});
        schedule();
      }
    }
    if(event.target.matches('.crypto-hash-checks input[value="hmac-sha256"]'))q('[data-file-hmac-key]').hidden=!event.target.checked;
    updateWarning();
  });
  lifecycle.event(overlay,'keydown',event=>{
    const trigger=event.target.closest('[data-crypto-select-trigger]');
    if(trigger&&['ArrowDown','ArrowUp'].includes(event.key)){
      event.preventDefault();
      const control=trigger.closest('.crypto-select');
      const menu=control.querySelector('[data-crypto-select-menu]');
      if(menu.hidden)trigger.click();
      const items=Array.from(menu.querySelectorAll('[data-crypto-select-value]'));
      const selected=items.findIndex(item=>item.classList.contains('is-selected'));
      items[event.key==='ArrowUp'?Math.max(0,selected-1):Math.min(items.length-1,selected+1)]?.focus();
      return;
    }
    const item=event.target.closest('[data-crypto-select-value]');
    if(item&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();
      const items=Array.from(item.parentElement.querySelectorAll('[data-crypto-select-value]'));
      let index=items.indexOf(item);
      if(event.key==='Home')index=0;
      else if(event.key==='End')index=items.length-1;
      else index=Math.max(0,Math.min(items.length-1,index+(event.key==='ArrowDown'?1:-1)));
      items[index]?.focus();
      return;
    }
    if(event.key==='Escape'){
      const control=event.target.closest('.crypto-select');
      if(!control)return;
      event.preventDefault();
      closeSelectMenus();
      control.querySelector('[data-crypto-select-trigger]')?.focus();
    }
  });
  async function attachProgress(){const requestId=++listenerId;try{const stop=await listen('tool-operation-progress',event=>{const payload=event.payload||{};if(payload.operation_id!==fileOperationId&&payload.operationId!==fileOperationId)return;const percent=Math.max(0,Math.min(100,Number(payload.percent)||0));q('[data-file-progress]')&&(q('[data-file-progress]').style.width=`${percent}%`);q('[data-file-progress-text]')&&(q('[data-file-progress-text]').textContent=`${payload.phase||'processing'} · ${percent.toFixed(0)}%`);});if(typeof stop!=='function')return;if(requestId!==listenerId||!overlay.classList.contains('visible')){stop();return;}unlisten.push(stop);}catch{ /* browser preview has no Tauri event bridge */ }}
  const api={open(){if(disposed)throw new Error('crypto:disposed');backgroundDispose?.();backgroundDispose=mountToolPageBackground(shell);overlay.classList.add('visible');overlay.setAttribute('aria-hidden','false');render();void attachProgress();},close(){if(disposed)return;viewId+=1;listenerId+=1;invalidateWorker();backgroundDispose?.();backgroundDispose=null;void cancelFile();unlisten.forEach(fn=>fn());unlisten=[];fileOperationId='';filePath='';clearSecrets();logs=[];overlay.classList.remove('visible');overlay.setAttribute('aria-hidden','true');},dispose(){if(disposed)return;api.close();disposed=true;lifecycle.dispose();overlay.replaceChildren();}};
  return api;
}
