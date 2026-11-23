// HA STT 컴포넌트의 말 끝 감지(ha/custom_components/ha_agent_assist/endpoint.py)를 python3로 시험한다(test/endpoint_check.py).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./endpoint_check.py', import.meta.url))
const hasPython = spawnSync('python3', ['--version']).status === 0

test('말 끝 감지(endpoint.py): 조용한 방·소음·옆방 TV·바로 말하기·상한', { skip: hasPython ? false : 'python3 없음' }, () => {
	const r = spawnSync('python3', ['-I', script], { encoding: 'utf8', timeout: 120000 })
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
	assert.match(r.stderr, /\nOK\s*$/)
})
