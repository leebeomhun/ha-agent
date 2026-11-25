// HA Assist 주력 대화 HTTP 서버 + OpenAI 호환 API + Tailscale 경량 관리 웹 콘솔
import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { expandHome, log, DAY } from '../util.mjs'
import { mineRoutines, scoreRules, generateSelfProposals, loadEvalCases, evaluateExperiment, evaluateDueExperiments } from '../engine/learning.mjs'
import { renderScorecard } from '../engine/scorecard.mjs'
import { scanDeviceHealth } from '../engine/device-health.mjs'

const MAX_BODY = 256 * 1024
const MAX_AUDIO_BODY = 10 * 1024 * 1024
const AUTH_WINDOW_MS = 5 * 60 * 1000
const AUTH_MAX_FAILS = 20
const SEC_HEADERS = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'no-referrer',
}
const CONSOLE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'"

const hash = s => createHash('sha256').update(String(s ?? '')).digest()
const eqSecret = (a, b) => Boolean(a && b && timingSafeEqual(hash(a), hash(b)))

export function normalizeIp(raw) {
	let s = String(raw ?? '').trim().replace(/%.+$/, '')
	if (s.startsWith('::ffff:')) s = s.slice(7)
	return s.toLowerCase()
}

function ipv4ToInt(ip) {
	const parts = ip.split('.')
	if (parts.length !== 4) return null
	let n = 0
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null
		const v = Number(p)
		if (v < 0 || v > 255) return null
		n = (n * 256) + v
	}
	return n >>> 0
}

function ipv6ToBigInt(ip) {
	if (!ip.includes(':')) return null
	const halves = ip.split('::')
	if (halves.length > 2) return null
	const parseSide = side => (side ? side.split(':') : [])
	const left = parseSide(halves[0])
	const right = halves.length === 2 ? parseSide(halves[1]) : []
	if (halves.length === 1 && left.length !== 8) return null
	if (halves.length === 2 && left.length + right.length >= 8) return null
	const missing = halves.length === 2 ? 8 - left.length - right.length : 0
	const groups = [...left, ...Array(missing).fill('0'), ...right]
	if (groups.length !== 8) return null
	let out = 0n
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
		out = (out << 16n) + BigInt(parseInt(g, 16))
	}
	return out
}

export function ipMatchesCidr(rawIp, rule) {
	const ip = normalizeIp(rawIp)
	const spec = normalizeIp(rule)
	if (!ip || !spec) return false
	const slash = spec.indexOf('/')
	if (slash === -1) return ip === spec
	const net = spec.slice(0, slash)
	const prefix = Number(spec.slice(slash + 1))
	if (!Number.isInteger(prefix) || prefix < 0) return false
	const ip4 = ipv4ToInt(ip), net4 = ipv4ToInt(net)
	if (ip4 !== null && net4 !== null) {
		if (prefix > 32) return false
		const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
		return (ip4 & mask) === (net4 & mask)
	}
	const ip6 = ipv6ToBigInt(ip), net6 = ipv6ToBigInt(net)
	if (ip6 !== null && net6 !== null) {
		if (prefix > 128) return false
		const shift = BigInt(128 - prefix)
		return (ip6 >> shift) === (net6 >> shift)
	}
	return false
}

export function isIpAllowed(rawIp, allowedNetworks) {
	if (!Array.isArray(allowedNetworks) || !allowedNetworks.length) return true
	return allowedNetworks.some(entry => ipMatchesCidr(rawIp, entry))
}

export function ensureAssistToken(tokenFile) {
	const p = expandHome(tokenFile || '~/.config/ha-agent/assist-token')
	if (existsSync(p)) {
		const t = readFileSync(p, 'utf8').trim()
		if (t) return t
	}
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tok = randomBytes(32).toString('hex')
	writeFileSync(p, tok + '\n', { mode: 0o600 })
	return tok
}

// 클라이언트 잘못(본문 초과·JSON 오류 등)은 이 오류로 던져 알맞은 4xx와 그 이유를 돌려준다.
// 그 밖의 예외는 500과 일반 문구만 돌려주고, 자세한 내용은 서버 로그에만 남긴다.
export class HttpError extends Error {
	constructor(status, message) {
		super(message)
		this.status = status
	}
}

function readRawBody(req, maxBytes = MAX_AUDIO_BODY) {
	return new Promise((resolve, reject) => {
		let size = 0
		let tooBig = false
		const chunks = []
		req.on('data', c => {
			size += c.length
			if (tooBig) {
				// 413을 보낸 뒤에도 남은 본문은 버리며 받는다(바로 끊으면 클라이언트는 응답 대신 연결 오류를 본다). 너무 크면 끊는다.
				if (size > maxBytes * 4) req.destroy()
				return
			}
			if (size > maxBytes) {
				tooBig = true
				chunks.length = 0
				reject(new HttpError(413, `요청 본문이 너무 큼 (최대 ${Math.round(maxBytes / 1024)}KB)`))
				return
			}
			chunks.push(c)
		})
		req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks)) })
		req.on('error', reject)
	})
}

function readJsonBody(req, maxBytes = MAX_BODY) {
	return readRawBody(req, maxBytes).then(buf => {
		const text = buf.toString('utf8').trim()
		if (!text) return {}
		let body
		try { body = JSON.parse(text) } catch { throw new HttpError(400, 'JSON 파싱 실패') }
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON 본문은 객체여야 함')
		return body
	})
}

const sendJson = (res, status, data) => {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS })
	res.end(JSON.stringify(data))
}

const CONSOLE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>집 비서 (ha-agent) 콘솔</title>
<style>
:root{--bg:#0f172a;--card:#1e293b;--fg:#e2e8f0;--muted:#94a3b8;--acc:#38bdf8;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;--line:#334155}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);line-height:1.5}
header{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);background:#0b1220;position:sticky;top:0}
header h1{margin:0;font-size:16px}
.auth{display:flex;gap:8px;align-items:center}
input,button,textarea{font:inherit;color:var(--fg);background:#0b1220;border:1px solid var(--line);border-radius:8px;padding:6px 10px}
button{cursor:pointer;background:#1d4ed8;border-color:#2563eb}button.sec{background:#334155;border-color:#475569}button.bad{background:#991b1b;border-color:#dc2626}button.ok{background:#15803d;border-color:#16a34a}
nav{display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid var(--line)}
nav button.active{background:var(--acc);color:#0f172a;font-weight:700;border-color:var(--acc)}
main{max-width:980px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.chat{display:flex;flex-direction:column;gap:8px;max-height:55vh;overflow:auto;margin-bottom:10px}
.msg{padding:10px 12px;border-radius:10px;max-width:85%;white-space:pre-wrap}.msg.user{align-self:flex-end;background:#1d4ed8}.msg.bot{align-self:flex-start;background:#0f172a;border:1px solid var(--line)}
pre{background:#0b1220;padding:10px;border-radius:8px;overflow:auto;font-size:12px;border:1px solid var(--line)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.muted{color:var(--muted);font-size:13px}
.hidden{display:none}
</style>
</head>
<body>
<header>
  <h1>🤖 집 비서 (ha-agent)</h1>
  <div class="auth">
    <input id="tok" type="password" placeholder="Assist Bearer 토큰" size="26">
    <button onclick="saveTok()">연결</button>
  </div>
</header>
<nav>
  <button id="t-chat" class="active" onclick="tab('chat')">Assist 채팅</button>
  <button id="t-prop" onclick="tab('prop')">승인/제안 큐</button>
  <button id="t-mem" onclick="tab('mem')">메모리 관리</button>
  <button id="t-learn" onclick="tab('learn')">자가학습·실험</button>
  <button id="t-sys" onclick="tab('sys')">상태·정책</button>
</nav>
<main>
  <section id="p-chat" class="card">
    <div id="chatLog" class="chat"></div>
    <form class="row" onsubmit="sendChat(event)">
      <input id="chatIn" style="flex:1" placeholder="집 상태 물어보기, 기기 제어, 자동화 제안 요청..." autocomplete="off">
      <button type="button" id="micBtn" class="sec" onclick="toggleMic()" title="음성 입력 (HTTPS/localhost)">🎤</button>
      <label class="muted" style="display:flex;align-items:center;gap:4px"><input id="ttsChk" type="checkbox">🔊 음성 응답</label>
      <button type="submit">보내기</button>
      <button type="button" class="sec" onclick="resetConv()">새 대화</button>
    </form>
    <div id="voiceInfo" class="muted" style="margin-top:6px"></div>
  </section>
  <section id="p-prop" class="card hidden">
    <div class="row" style="justify-content:space-between;margin-bottom:8px">
      <strong>HA 관리 · 자가 튜닝 제안 (Tier 2 승인·롤백)</strong>
      <button class="sec" onclick="loadProposals()">새로고침</button>
    </div>
    <div id="propList" class="muted">토큰을 입력하면 목록이 표시됩니다.</div>
  </section>
  <section id="p-mem" class="card hidden">
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <strong>구조화 장기 기억 관리 (고정·만료·이력·의미 검색)</strong>
      <div class="row">
        <button class="sec" onclick="reindexMem()">임베딩 재색인</button>
        <button class="sec" onclick="consolidateMem()">기억 통합 정리</button>
        <button class="sec" onclick="loadMemory()">새로고침</button>
      </div>
    </div>
    <form class="row" style="margin-bottom:10px" onsubmit="event.preventDefault();loadMemory()">
      <input id="mSearch" placeholder="하이브리드 의미 검색 (예: 전원 복구, 욕실 배기팬...)" style="flex:1">
      <label class="muted" style="display:flex;align-items:center;gap:4px"><input id="mArch" type="checkbox" onchange="loadMemory()">보관함 포함</label>
      <button type="submit" class="sec">검색</button>
      <button type="button" class="sec" onclick="document.getElementById('mSearch').value='';loadMemory()">초기화</button>
    </form>
    <form class="row" style="margin-bottom:10px" onsubmit="addMemory(event)">
      <select id="mCat" style="background:#0b1220;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px">
        <option value="standing_order">지시사항</option>
        <option value="preference">선호</option>
        <option value="pattern">패턴</option>
        <option value="incident">장애·임시</option>
        <option value="rejection">거절</option>
      </select>
      <input id="mKey" placeholder="키(영문_밑줄)" size="16" required>
      <input id="mContent" placeholder="기억할 내용(한국어)" style="flex:1" required>
      <input id="mTtl" type="number" placeholder="만료일" style="width:74px" min="0">
      <label class="muted" style="display:flex;align-items:center;gap:4px"><input id="mPin" type="checkbox">고정</label>
      <button type="submit">저장</button>
    </form>
    <div id="memHygiene" class="muted" style="margin-bottom:8px"></div>
    <div id="memList" class="muted">토큰을 입력하면 목록이 표시됩니다.</div>
  </section>
  <section id="p-learn" class="card hidden">
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <strong>자가학습 · 교훈(Playbook) · 사후 검증 실험</strong>
      <div class="row">
        <button class="sec" onclick="showScorecard()">성능 지표</button>
        <button class="sec" onclick="findAutomations()">루틴 자동화 후보 보기</button>
        <button class="sec" onclick="proposeAutomations()">루틴 자동화 제안 올리기</button>
        <button class="sec" onclick="proposeSelf()">자가 튜닝 후보 제안 등록</button>
        <button class="sec" onclick="loadLearning()">새로고침</button>
      </div>
    </div>
    <div id="learnOut" class="muted">토큰을 입력하면 학습 현황이 표시됩니다.</div>
  </section>
  <section id="p-sys" class="card hidden">
    <div class="row" style="margin-bottom:10px">
      <button class="sec" onclick="loadSys()">상태/통계/정책 새로고침</button>
      <button class="sec" onclick="runAudit()">HA 건강 감사 실행</button>
    </div>
    <pre id="sysOut">대기 중...</pre>
  </section>
</main>
<script>
let convId = sessionStorage.getItem('haagent_conv') || '';
const tokInput = document.getElementById('tok');
tokInput.value = sessionStorage.getItem('haagent_tok') || '';
function saveTok(){ sessionStorage.setItem('haagent_tok', tokInput.value.trim()); loadProposals(); loadMemory(); loadLearning(); loadSys(); }
async function api(path, opt = {}) {
  const t = tokInput.value.trim() || sessionStorage.getItem('haagent_tok') || '';
  const r = await fetch(path, { ...opt, headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t, ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({ error: '응답 오류' }));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function tab(name){
  for (const k of ['chat','prop','mem','learn','sys']) {
    document.getElementById('p-'+k).classList.toggle('hidden', k !== name);
    document.getElementById('t-'+k).classList.toggle('active', k === name);
  }
  if (name === 'prop') loadProposals();
  if (name === 'mem') loadMemory();
  if (name === 'learn') loadLearning();
  if (name === 'sys') loadSys();
}
function addMsg(role, text){
  const el = document.createElement('div');
  el.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  el.textContent = text;
  const box = document.getElementById('chatLog');
  box.appendChild(el); box.scrollTop = box.scrollHeight;
}
function resetConv(){ convId = ''; sessionStorage.removeItem('haagent_conv'); document.getElementById('chatLog').textContent = ''; document.getElementById('voiceInfo').textContent = ''; }
let mediaRec = null, recChunks = [], recStream = null;
async function playTts(text){
  const t = tokInput.value.trim() || sessionStorage.getItem('haagent_tok') || '';
  const t0 = performance.now();
  const r = await fetch('/api/assist/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t },
    body: JSON.stringify({ text })
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('TTS HTTP ' + r.status)); }
  const blob = await r.blob();
  const ttsMs = Math.round(performance.now() - t0);
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play().catch(() => {});
  return { ttsMs, cached: r.headers.get('x-ha-agent-cached') === '1' };
}
async function submitText(text, timings = {}){
  addMsg('user', text);
  const infoEl = document.getElementById('voiceInfo');
  const t0 = performance.now();
  try {
    const r = await api('/api/assist/converse', { method: 'POST', body: JSON.stringify({ text, conversation_id: convId || undefined, channel: 'web' }) });
    convId = r.conversation_id; sessionStorage.setItem('haagent_conv', convId);
    const speech = r.response?.speech || JSON.stringify(r);
    addMsg('bot', speech);
    const llmMs = r.ms ?? Math.round(performance.now() - t0);
    const parts = [];
    if (timings.sttMs != null) parts.push('STT ' + timings.sttMs + 'ms');
    parts.push('대화 ' + llmMs + 'ms');
    if (document.getElementById('ttsChk').checked) {
      const t = await playTts(speech);
      parts.push('TTS ' + t.ttsMs + 'ms' + (t.cached ? '(캐시)' : ''));
    }
    infoEl.textContent = parts.join(' · ');
  } catch (err) { addMsg('bot', '오류: ' + err.message); }
}
async function sendChat(e){
  e.preventDefault();
  const inp = document.getElementById('chatIn'), text = inp.value.trim();
  if (!text) return; inp.value = '';
  await submitText(text);
}
async function toggleMic(){
  const btn = document.getElementById('micBtn'), infoEl = document.getElementById('voiceInfo');
  if (mediaRec && mediaRec.state === 'recording') { mediaRec.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    infoEl.textContent = '이 브라우저 또는 HTTP 주소에서는 마이크를 사용할 수 없습니다 (HTTPS 또는 localhost 필요).';
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
    mediaRec = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream);
    mediaRec.ondataavailable = ev => { if (ev.data.size > 0) recChunks.push(ev.data); };
    mediaRec.onstop = async () => {
      btn.textContent = '🎤'; btn.className = 'sec';
      recStream.getTracks().forEach(tr => tr.stop());
      const blob = new Blob(recChunks, { type: mediaRec.mimeType || 'audio/webm' });
      infoEl.textContent = '음성 인식 중...';
      try {
        const t = tokInput.value.trim() || sessionStorage.getItem('haagent_tok') || '';
        const t0 = performance.now();
        const r = await fetch('/api/assist/stt?language=ko', {
          method: 'POST',
          headers: { 'content-type': blob.type || 'audio/webm', 'authorization': 'Bearer ' + t },
          body: blob
        });
        const j = await r.json().catch(() => ({ error: '응답 오류' }));
        if (!r.ok) throw new Error(j.error || ('STT HTTP ' + r.status));
        const sttMs = j.ms ?? Math.round(performance.now() - t0);
        if (!j.text) { infoEl.textContent = '인식된 음성이 없습니다.'; return; }
        await submitText(j.text, { sttMs });
      } catch (err) { infoEl.textContent = '음성 오류: ' + err.message; }
    };
    mediaRec.start();
    btn.textContent = '⏹️'; btn.className = 'bad';
    infoEl.textContent = '듣고 있어요... 다시 누르면 전송합니다.';
  } catch (err) { infoEl.textContent = '마이크 오류: ' + err.message; }
}
const ROLLBACK_KINDS = new Set(['automation_upsert','automation_delete','automation_toggle','script_upsert','script_delete','promote_rule','scene_upsert','scene_delete','helper_upsert','helper_delete','self_alias_proposal','self_noise_proposal','self_stt_tune','self_lesson_proposal']);
async function loadMemory(){
  try {
    const q = (document.getElementById('mSearch')?.value || '').trim();
    const arch = document.getElementById('mArch')?.checked ? '1' : '';
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (arch) qs.set('archived', '1');
    const data = await api('/api/memory' + (qs.toString() ? '?' + qs.toString() : ''));
    const hy = document.getElementById('memHygiene');
    const emb = data.embedding;
    const embText = emb ? ('임베딩: ' + (emb.target_model || 'local') + (emb.target_dims ? '/' + emb.target_dims + 'd' : '') + ' (' + (emb.active_matching ?? emb.matching_target ?? 0) + '/' + (emb.active_total ?? emb.total ?? 0) + ')') : '';
    const parts = [];
    if (embText) parts.push(embText);
    if (data.hygiene && data.hygiene.length) parts.push('정리 힌트: ' + data.hygiene.join(' | '));
    hy.textContent = parts.join(' · ');
    const box = document.getElementById('memList');
    box.textContent = '';
    if (!data.items || !data.items.length) {
      const empty = document.createElement('div'); empty.className = 'muted'; empty.textContent = q ? '검색 결과가 없습니다.' : '등록된 구조화 기억이 없습니다.';
      box.appendChild(empty); return;
    }
    for (const it of data.items) {
      const d = document.createElement('div'); d.className = 'card';
      const hdr = document.createElement('div'); hdr.className = 'row'; hdr.style.justifyContent = 'space-between';
      const left = document.createElement('b');
      left.textContent = (it.pinned ? '📌 ' : '') + '[' + it.category + '] ' + it.key;
      const meta = document.createElement('span'); meta.className = 'muted';
      const exp = it.expires_at ? ('만료 ' + new Date(it.expires_at).toLocaleDateString('ko-KR')) : '무기한';
      meta.textContent = '우선 ' + (it.priority || 3) + ' · 조회 ' + (it.hit_count || 0) + ' · ' + exp;
      hdr.append(left, meta);
      const body = document.createElement('p'); body.textContent = it.content;
      const btns = document.createElement('div'); btns.className = 'row';
      const bPin = document.createElement('button'); bPin.className = 'sec'; bPin.textContent = it.pinned ? '고정 해제' : '고정';
      bPin.onclick = async () => { await api('/api/memory/' + encodeURIComponent(it.key) + '/pin', { method: 'POST', body: JSON.stringify({ pinned: !it.pinned }) }); loadMemory(); };
      const bDel = document.createElement('button'); bDel.className = 'bad'; bDel.textContent = '삭제';
      bDel.onclick = async () => { await api('/api/memory/' + encodeURIComponent(it.key), { method: 'DELETE' }); loadMemory(); };
      btns.append(bPin, bDel);
      d.append(hdr, body, btns); box.appendChild(d);
    }
  } catch (err) { document.getElementById('memList').textContent = '불러오기 실패: ' + err.message; }
}
async function addMemory(e){
  e.preventDefault();
  const ttlRaw = document.getElementById('mTtl').value;
  await api('/api/memory', {
    method: 'POST',
    body: JSON.stringify({
      category: document.getElementById('mCat').value,
      key: document.getElementById('mKey').value.trim(),
      content: document.getElementById('mContent').value.trim(),
      ttl_days: ttlRaw === '' ? null : Number(ttlRaw),
      pinned: document.getElementById('mPin').checked
    })
  });
  document.getElementById('mKey').value = '';
  document.getElementById('mContent').value = '';
  document.getElementById('mTtl').value = '';
  document.getElementById('mPin').checked = false;
  loadMemory();
}
async function consolidateMem(){
  await api('/api/memory/consolidate', { method: 'POST' });
  loadMemory();
}
async function reindexMem(){
  const r = await api('/api/memory/reindex', { method: 'POST' });
  alert('임베딩 재색인 완료 (' + r.model + '): 갱신 ' + r.updated + '건 / 스킵 ' + r.skipped + '건 / 실패 ' + r.failed + '건');
  loadMemory();
}
async function loadLearning(){
  try {
    const d = await api('/api/learning');
    const box = document.getElementById('learnOut');
    box.textContent = '';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(d, null, 2);
    box.appendChild(pre);
  } catch (err) { document.getElementById('learnOut').textContent = '불러오기 실패: ' + err.message; }
}
function showText(text){
  const box = document.getElementById('learnOut'); box.textContent = '';
  const pre = document.createElement('pre'); pre.textContent = text; box.appendChild(pre);
}
async function showScorecard(){
  try { const r = await api('/api/scorecard'); showText(r.text); } catch (err) { showText('불러오기 실패: ' + err.message); }
}
function suggestionLines(r){
  const lines = (r.candidates || []).map(c => (c.status === 'skipped' ? '· ' : c.status === 'proposed' ? '📨 ' : '✅ ') + c.name + ' ' + c.day_type + ' ' + c.window + ' ' + (c.direction === 'on' ? '켜기' : '끄기') + (c.status === 'skipped' ? ' — 건너뜀: ' + c.reason : '\\n    ' + (c.evidence || '')));
  return (lines.length ? lines.join('\\n') : '루틴 후보가 없어요') + ((r.created || []).length ? '\\n\\n새 제안 ' + r.created.length + '건을 승인 대기에 올렸어요.' : '');
}
async function findAutomations(){
  showText('계산 중...');
  try { showText(suggestionLines(await api('/api/automation-suggestions'))); } catch (err) { showText('실패: ' + err.message); }
}
async function proposeAutomations(){
  showText('제안 올리는 중...');
  try { showText(suggestionLines(await api('/api/automation-suggestions', { method: 'POST' }))); loadProposals(); } catch (err) { showText('실패: ' + err.message); }
}
async function proposeSelf(){
  try {
    const r = await api('/api/learning/propose-self', { method: 'POST' });
    loadProposals(); loadLearning();
    alert('자가 튜닝 제안 등록: ' + (r.created ? r.created.length : 0) + '건');
  } catch (err) { alert('실패: ' + err.message); }
}
async function loadProposals(){
  try {
    const { proposals } = await api('/api/proposals');
    const box = document.getElementById('propList');
    box.textContent = '';
    if (!proposals.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = '제안이 없습니다.';
      box.appendChild(empty);
      return;
    }
    for (const p of proposals) {
      const d = document.createElement('div'); d.className = 'card';
      const hdr = document.createElement('div'); hdr.className = 'row'; hdr.style.justifyContent = 'space-between';
      const title = document.createElement('b'); title.textContent = '[' + p.status + '] ' + p.title;
      const meta = document.createElement('span'); meta.className = 'muted'; meta.textContent = p.pid + ' · ' + p.kind;
      hdr.append(title, meta);
      const sum = document.createElement('p'); sum.textContent = p.summary;
      d.append(hdr, sum);
      if (p.diff_text) {
        const pre = document.createElement('pre'); pre.textContent = p.diff_text;
        d.appendChild(pre);
      }
      const btns = document.createElement('div'); btns.className = 'row';
      if (p.status === 'pending') {
        const b1 = document.createElement('button'); b1.className = 'ok'; b1.textContent = '승인'; b1.onclick = async () => { await api('/api/proposals/' + p.pid + '/approve', { method: 'POST' }); loadProposals(); };
        const b2 = document.createElement('button'); b2.className = 'bad'; b2.textContent = '거절'; b2.onclick = async () => { await api('/api/proposals/' + p.pid + '/reject', { method: 'POST' }); loadProposals(); };
        btns.append(b1, b2);
      } else if (['applied', 'rollback_failed', 'interrupted'].includes(p.status) && ROLLBACK_KINDS.has(p.kind)) {
        const b3 = document.createElement('button'); b3.className = 'bad'; b3.textContent = '롤백'; b3.onclick = async () => { await api('/api/proposals/' + p.pid + '/rollback', { method: 'POST' }); loadProposals(); };
        btns.append(b3);
      }
      d.appendChild(btns); box.appendChild(d);
    }
  } catch (err) { document.getElementById('propList').textContent = '불러오기 실패: ' + err.message; }
}
async function loadSys(){
  try {
    const [st, pol, mem] = await Promise.all([api('/api/status'), api('/api/policy'), api('/api/memory')]);
    document.getElementById('sysOut').textContent = JSON.stringify({ status: st, policy: pol, memory_items: mem.items }, null, 2);
  } catch (err) { document.getElementById('sysOut').textContent = '불러오기 실패: ' + err.message; }
}
async function runAudit(){
  try {
    const r = await api('/api/audit', { method: 'POST' });
    document.getElementById('sysOut').textContent = JSON.stringify(r, null, 2);
  } catch (err) { document.getElementById('sysOut').textContent = '감사 실패: ' + err.message; }
}
</script>
</body></html>`

export class AssistServer {
	constructor({ cfg, agent, token = null } = {}) {
		this.cfg = cfg
		this.agent = agent
		this.token = token
		this.server = null
		this.port = null
		this.authFailures = new Map()
	}

	async start() {
		const a = this.cfg.assist ?? {}
		if (!this.token) this.token = ensureAssistToken(a.token_file)
		this.server = createServer((req, res) => {
			this.#handle(req, res).catch(e => {
				if (e instanceof HttpError) {
					log(`Assist HTTP ${e.status} (${req.method} ${String(req.url ?? '').split('?')[0]}): ${e.message}`)
					if (!res.headersSent) sendJson(res, e.status, { error: e.message })
					return
				}
				log(`Assist HTTP 오류 (${req.method} ${String(req.url ?? '').split('?')[0]}):`, e?.stack ?? e)
				if (!res.headersSent) sendJson(res, 500, { error: '서버 내부 오류 (자세한 내용은 ha-agent 로그 확인)' })
			})
		})
		await new Promise((resolve, reject) => {
			this.server.once('error', reject)
			this.server.listen(a.port ?? 8787, a.host ?? '0.0.0.0', () => {
				this.port = this.server.address()?.port ?? a.port
				log(`Assist HTTP 서버 시작: http://${a.host ?? '0.0.0.0'}:${this.port}`)
				resolve()
			})
		})
		return this.port
	}

	async stop() {
		if (!this.server) return
		const srv = this.server
		this.server = null
		srv.closeIdleConnections?.()
		await new Promise(res => {
			const t = setTimeout(() => { srv.closeAllConnections?.(); res() }, 3000)
			t.unref()
			srv.close(() => { clearTimeout(t); res() })
		})
	}

	#authorized(req) {
		const h = req.headers.authorization ?? ''
		const m = /^Bearer\s+(.+)$/i.exec(h)
		return Boolean(m && eqSecret(m[1].trim(), this.token))
	}

	#isRateLimited(ip, now) {
		const rec = this.authFailures.get(ip)
		if (!rec) return false
		if (now >= rec.resetAt) {
			this.authFailures.delete(ip)
			return false
		}
		return rec.count >= AUTH_MAX_FAILS
	}

	#recordAuthFailure(ip, now) {
		if (this.authFailures.size > 100) {
			for (const [k, v] of this.authFailures) if (now >= v.resetAt) this.authFailures.delete(k)
		}
		const prev = this.authFailures.get(ip)
		const rec = (!prev || now >= prev.resetAt) ? { count: 1, resetAt: now + AUTH_WINDOW_MS } : { count: prev.count + 1, resetAt: prev.resetAt }
		this.authFailures.set(ip, rec)
		if (rec.count === AUTH_MAX_FAILS) log(`Assist 인증 실패 한도 초과 (${ip}, 5분간 차단)`)
		return rec.count >= AUTH_MAX_FAILS
	}

	async #handle(req, res) {
		const clientIp = normalizeIp(req.socket?.remoteAddress || '')
		if (!isIpAllowed(clientIp, this.cfg.assist?.allowed_networks)) {
			return sendJson(res, 403, { error: '허용되지 않은 네트워크 접근' })
		}

		const url = new URL(req.url || '/', 'http://localhost')
		const path = url.pathname
		const method = req.method?.toUpperCase() || 'GET'

		if (method === 'GET' && path === '/health') {
			return sendJson(res, 200, { ok: true })
		}
		if (method === 'GET' && path === '/') {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'content-security-policy': CONSOLE_CSP,
				...SEC_HEADERS,
			})
			return res.end(CONSOLE_HTML)
		}

		const now = Date.now()
		if (this.#isRateLimited(clientIp, now)) {
			return sendJson(res, 429, { error: '인증 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' })
		}
		if (!this.#authorized(req)) {
			const limited = this.#recordAuthFailure(clientIp, now)
			return sendJson(res, limited ? 429 : 401, { error: limited ? '인증 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' : '인증 실패 (Bearer 토큰 필요)' })
		}
		this.authFailures.delete(clientIp)

		if (method === 'GET' && path === '/api/assist/voice-config') {
			return sendJson(res, 200, { endpoint: this.cfg.assist?.voice?.endpoint ?? {} })
		}

		if (method === 'POST' && path === '/api/assist/stt') {
			const ctype = String(req.headers['content-type'] ?? '').toLowerCase()
			let audioBuffer, mimeType = url.searchParams.get('mime_type') || 'audio/wav', language = url.searchParams.get('language') || 'ko'
			if (ctype.includes('application/json')) {
				const body = await readJsonBody(req, Math.ceil(MAX_AUDIO_BODY * 1.4))
				const b64 = String(body.audio_base64 ?? '').trim()
				if (!b64) return sendJson(res, 400, { error: 'audio_base64가 비어 있음' })
				audioBuffer = Buffer.from(b64, 'base64')
				mimeType = String(body.mime_type ?? mimeType)
				language = String(body.language ?? language)
			} else {
				audioBuffer = await readRawBody(req, MAX_AUDIO_BODY)
				if (!audioBuffer.length) return sendJson(res, 400, { error: '오디오 본문이 비어 있음' })
				const sr = url.searchParams.get('sample_rate')
				const ch = url.searchParams.get('channels')
				if (ctype && !ctype.startsWith('application/octet-stream')) mimeType = ctype
				if (sr && !/rate=/i.test(mimeType)) mimeType += `;rate=${Number(sr) || 16000}`
				if (ch && !/channels=/i.test(mimeType)) mimeType += `;channels=${Number(ch) || 1}`
			}
			// HA STT 컴포넌트가 보낸 말 끝 감지 결과(로그·디버그용)
			const endpoint = url.searchParams.get('ep_reason') ? Object.fromEntries(
				['reason', 'cut_ms', 'start_ms', 'keep_ms', 'noise_db', 'bg_db', 'speech_db']
					.map(k => [k, url.searchParams.get(`ep_${k}`)])
					.filter(([, v]) => v !== null && v !== '')
					.map(([k, v]) => [k, k === 'reason' ? v.slice(0, 20) : Number(v)]),
			) : null
			const r = await this.agent.handleStt({ audioBuffer, mimeType, language, endpoint })
			return sendJson(res, 200, r)
		}

		if (method === 'POST' && path === '/api/assist/tts') {
			const body = await readJsonBody(req)
			const text = String(body.text ?? '').trim()
			if (!text) return sendJson(res, 400, { error: 'text가 비어 있음' })
			const r = await this.agent.handleTts({
				text,
				language: body.language ?? null,
				voice: body.voice ?? null,
			})
			res.writeHead(200, {
				'content-type': r.mimeType || 'audio/wav',
				'content-length': r.audio.length,
				'cache-control': 'no-store',
				'x-ha-agent-ms': String(r.ms ?? 0),
				'x-ha-agent-model': String(r.model ?? ''),
				'x-ha-agent-cached': r.cached ? '1' : '0',
				...SEC_HEADERS,
			})
			return res.end(r.audio)
		}

		if (method === 'POST' && path === '/api/assist/converse') {
			const body = await readJsonBody(req)
			const text = String(body.text ?? '').trim()
			if (!text) return sendJson(res, 400, { error: 'text가 비어 있음' })
			const r = await this.agent.handleAssist({
				text: text.slice(0, 2000),
				conversationId: body.conversation_id ?? null,
				language: body.language ?? 'ko',
				deviceId: body.device_id ?? null,
				userId: body.user_id ?? null,
				channel: body.channel ?? 'ha_assist',
			})
			return sendJson(res, 200, {
				conversation_id: r.conversation_id,
				continue_conversation: Boolean(r.continue_conversation),
				response: { speech: r.speech, language: body.language ?? 'ko' },
				actions: r.actions ?? [],
				proposals: r.proposals ?? [],
				ms: r.ms ?? null,
			})
		}

		if (method === 'GET' && path === '/v1/models') {
			return sendJson(res, 200, { object: 'list', data: [{ id: 'ha-agent', object: 'model', owned_by: 'ha-agent' }] })
		}

		if (method === 'POST' && path === '/v1/chat/completions') {
			const body = await readJsonBody(req)
			const msgs = Array.isArray(body.messages) ? body.messages : []
			const lastUser = [...msgs].reverse().find(m => m?.role === 'user')
			const text = typeof lastUser?.content === 'string'
				? lastUser.content.trim()
				: Array.isArray(lastUser?.content) ? lastUser.content.map(c => c?.text ?? '').join(' ').trim() : ''
			if (!text) return sendJson(res, 400, { error: 'user 메시지가 비어 있음' })
			const r = await this.agent.handleAssist({
				text: text.slice(0, 2000),
				conversationId: body.user ?? body.conversation_id ?? null,
				language: 'ko',
				channel: 'openai_compat',
			})
			return sendJson(res, 200, {
				id: `chatcmpl-${r.conversation_id}`,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: body.model || 'ha-agent',
				choices: [{ index: 0, message: { role: 'assistant', content: r.speech }, finish_reason: 'stop' }],
			})
		}

		if (method === 'GET' && path === '/api/status') {
			return sendJson(res, 200, this.agent.statusSummary())
		}
		if (method === 'GET' && path === '/api/policy') {
			return sendJson(res, 200, this.agent.policy.describe())
		}
		if (method === 'GET' && path === '/api/rules') {
			return sendJson(res, 200, { rules: this.agent.engine.rules, runtime: this.agent.runtime.rules })
		}
		if (method === 'GET' && path === '/api/memory') {
			const q = url.searchParams.get('q')
			const includeArchived = url.searchParams.get('archived') === '1'
			const rawItems = q
				? await this.agent.memoryMgr.searchAsync(q, null, { includeArchived })
				: this.agent.memoryMgr.list(null, { includeArchived })
			const items = rawItems.map(({ embedding, ...rest }) => rest)
			return sendJson(res, 200, {
				legacy: this.agent.memoryMgr.readLegacy(),
				items,
				embedding: this.agent.memoryMgr.embeddingStats(),
				hygiene: this.agent.memoryMgr.hygieneHints(this.agent.clock()),
				history: this.agent.memoryMgr.history(null, 20),
			})
		}
		if (method === 'POST' && path === '/api/memory/reindex') {
			return sendJson(res, 200, await this.agent.memoryMgr.backfillEmbeddings({ includeArchived: true }))
		}
		if (method === 'POST' && path === '/api/memory') {
			const body = await readJsonBody(req)
			if (!body.key || !body.content) return sendJson(res, 400, { error: 'key와 content가 필요하다' })
			const r = this.agent.memoryMgr.applyOps([{
				op: 'upsert',
				category: body.category || 'preference',
				key: body.key,
				content: body.content,
				...(body.ttl_days !== undefined ? { ttl_days: body.ttl_days } : {}),
				...(body.pinned !== undefined ? { pinned: Boolean(body.pinned) } : {}),
				...(body.priority !== undefined ? { priority: Number(body.priority) } : {}),
				...(Array.isArray(body.entity_ids) ? { entity_ids: body.entity_ids } : {}),
			}], { source: 'console', now: this.agent.clock() })
			return sendJson(res, 200, { ok: true, ...r })
		}
		if (method === 'POST' && path === '/api/memory/consolidate') {
			return sendJson(res, 200, this.agent.memoryMgr.consolidate({ now: this.agent.clock() }))
		}
		const memRestore = /^\/api\/memory\/restore\/(\d+)$/.exec(path)
		if (method === 'POST' && memRestore) {
			const r = this.agent.memoryMgr.restoreVersion(Number(memRestore[1]), { source: 'console', now: this.agent.clock() })
			return sendJson(res, r.ok ? 200 : 400, r)
		}
		const memPin = /^\/api\/memory\/([^/]+)\/pin$/.exec(path)
		if (method === 'POST' && memPin) {
			const body = await readJsonBody(req)
			const key = decodeURIComponent(memPin[1])
			const item = this.agent.memoryMgr.setPinned(key, Boolean(body.pinned), { source: 'console', now: this.agent.clock() })
			if (!item) return sendJson(res, 404, { error: `기억을 찾지 못함: ${key}` })
			const { embedding, ...clean } = item
			return sendJson(res, 200, { ok: true, item: clean })
		}
		const memHist = /^\/api\/memory\/([^/]+)\/history$/.exec(path)
		if (method === 'GET' && memHist) {
			return sendJson(res, 200, { history: this.agent.memoryMgr.history(decodeURIComponent(memHist[1]), 30) })
		}
		const memDel = /^\/api\/memory\/([^/]+)$/.exec(path)
		if (method === 'DELETE' && memDel) {
			const key = decodeURIComponent(memDel[1])
			const r = this.agent.memoryMgr.applyOps([{ op: 'delete', key }], { source: 'console', force: true, now: this.agent.clock() })
			return sendJson(res, 200, { ok: r.deleted.length > 0, ...r })
		}

		if (method === 'GET' && path === '/api/learning') {
			const now = this.agent.clock()
			const st = this.agent.store
			return sendJson(res, 200, {
				lessons: st ? st.listLessons({ limit: 50 }) : [],
				experiments: st ? st.listExperiments({ limit: 30 }) : [],
				implicit_feedback: this.agent.implicitFeedback?.summarize({ sinceMs: now - 14 * DAY }) ?? { total: 0, by_kind: {}, top_entities: [] },
				rule_scorecard: scoreRules({ rules: this.agent.engine.rules, runtime: this.agent.runtime.rules, store: st, now }),
				routines: mineRoutines({ store: st, now, isNoise: this.agent.isNoise }),
				eval_cases: loadEvalCases(),
				self_proposal_candidates: generateSelfProposals({ store: st, cfg: this.agent.cfg, rules: this.agent.engine.rules, states: this.agent.states, now }),
				rollups: st ? { daily: st.listDailyRollups(14).length, monthly: st.listMonthlyRollups(12) } : null,
				scorecard: this.agent.scorecardNow?.(now) ?? null,
			})
		}
		if (method === 'GET' && path === '/api/scorecard') {
			const sc = this.agent.scorecardNow?.(this.agent.clock()) ?? null
			return sendJson(res, 200, { scorecard: sc, text: renderScorecard(sc) || '지표를 계산할 기록이 없어요' })
		}
		if (path === '/api/automation-suggestions' && (method === 'GET' || method === 'POST')) {
			if (!this.agent.suggestAutomationsNow) return sendJson(res, 400, { error: '지원하지 않음' })
			if (method === 'POST' && !this.agent.cfg.policy?.admin_enabled) return sendJson(res, 400, { error: 'HA 관리 권한(policy.admin_enabled)이 꺼져 있음' })
			return sendJson(res, 200, await this.agent.suggestAutomationsNow({ dry: method === 'GET' }))
		}
		if (method === 'GET' && path === '/api/health') {
			return sendJson(res, 200, scanDeviceHealth({ states: this.agent.states, meta: this.agent.meta ?? {}, cfg: this.agent.cfg, isNoise: this.agent.isNoise, now: this.agent.clock() }))
		}
		if (method === 'GET' && path === '/api/regression') {
			return sendJson(res, 200, this.agent.regressionNow())
		}
		if (method === 'POST' && path === '/api/learning/daily') {
			const r = await this.agent.runDailyLearning(this.agent.clock())
			return sendJson(res, r ? 200 : 409, r ?? { error: '이미 도는 중이거나 저장소가 없음' })
		}
		if (method === 'POST' && path === '/api/lessons') {
			if (!this.agent.store) return sendJson(res, 400, { error: '저장소 없음' })
			const body = await readJsonBody(req)
			if (!body.key || !body.condition_text || !body.rule_text) return sendJson(res, 400, { error: 'key, condition_text, rule_text 필수' })
			const item = this.agent.store.upsertLesson({ ...body, source: 'console', now: this.agent.clock() })
			return sendJson(res, 200, { ok: true, lesson: item })
		}
		const lesDel = /^\/api\/lessons\/([^/]+)$/.exec(path)
		if (method === 'DELETE' && lesDel) {
			if (!this.agent.store) return sendJson(res, 400, { error: '저장소 없음' })
			const r = this.agent.store.deleteLesson(decodeURIComponent(lesDel[1]), { source: 'console', force: true, now: this.agent.clock() })
			return sendJson(res, r.ok ? 200 : 404, r)
		}
		if (method === 'POST' && path === '/api/learning/propose-self') {
			const now = this.agent.clock()
			const cands = generateSelfProposals({ store: this.agent.store, cfg: this.agent.cfg, rules: this.agent.engine.rules, states: this.agent.states, now })
			const created = [], failed = []
			for (const c of cands) {
				const r = await this.agent.createAndNotifyProposal(c)
				if (r.ok) created.push(r.proposal)
				else failed.push({ title: c.title, error: r.error })
			}
			return sendJson(res, 200, { ok: true, created, failed })
		}
		const expEval = /^\/api\/experiments\/([^/]+)\/evaluate$/.exec(path)
		if (method === 'POST' && expEval) {
			if (!this.agent.store) return sendJson(res, 400, { error: '저장소 없음' })
			const eid = decodeURIComponent(expEval[1])
			const r = eid === 'due'
				? evaluateDueExperiments(this.agent.store, this.agent.clock())
				: evaluateExperiment(this.agent.store, eid, this.agent.clock())
			return sendJson(res, 200, { ok: true, result: r })
		}
		if (method === 'GET' && path === '/api/stats') {
			const { rangeStats } = await import('../records.mjs')
			const days = Math.max(1, Number(url.searchParams.get('days')) || 7)
			return sendJson(res, 200, rangeStats(days, this.agent.clock(), { store: this.agent.store }))
		}
		if (method === 'GET' && path === '/api/proposals') {
			const status = url.searchParams.get('status') || null
			return sendJson(res, 200, { proposals: this.agent.haAdmin.listProposals({ status }) })
		}

		const pm = /^\/api\/proposals\/([a-z0-9]+)\/(approve|reject|rollback)$/.exec(path)
		if (method === 'POST' && pm) {
			const [, pid, act] = pm
			const r = await this.agent.handleProposalAction(pid, act)
			return sendJson(res, r.ok ? 200 : 400, r)
		}

		if (method === 'POST' && path === '/api/audit') {
			return sendJson(res, 200, await this.agent.haAdmin.auditHealth())
		}
		if (method === 'POST' && path === '/api/wake') {
			const body = await readJsonBody(req)
			this.agent.enqueueExternal({ type: 'manual', reason: String(body.reason || '수동 점검').slice(0, 200), urgent: true })
			return sendJson(res, 200, { ok: true })
		}
		if (method === 'POST' && path === '/api/say') {
			const body = await readJsonBody(req)
			const text = String(body.text ?? '').trim()
			if (!text) return sendJson(res, 400, { error: 'text가 비어 있음' })
			const r = await this.agent.handleAssist({ text: text.slice(0, 2000), conversationId: body.conversation_id ?? null, channel: 'cli_say' })
			return sendJson(res, 200, r)
		}

		sendJson(res, 404, { error: '찾을 수 없는 경로' })
	}
}
