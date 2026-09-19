process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(root, 'challenge-data.json');
const submissionsFile = path.join(root, 'submissions.json');

const challenge = {
  id: 'two-sum',
  title: 'Two Sum',
  difficulty: 'Easy',
  points: 100,
  starterCode: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        # Write your solution here\n        pass\n',
  publicTests: [
    { nums: [2, 7, 11, 15], target: 9, expected: [0, 1] },
    { nums: [3, 2, 4], target: 6, expected: [1, 2] }
  ],
  hiddenTests: [
    { nums: [3, 3], target: 6, expected: [0, 1] },
    { nums: [-1, -2, -3, -4, -5], target: -8, expected: [2, 4] }
  ]
};

const dockerAvailable = () => {
  try {
    return spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', timeout: 2000 }).status === 0;
  } catch {
    return false;
  }
};

const getPythonCommand = () => {
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      if (spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 2000 }).status === 0) {
        return cmd;
      }
    } catch {}
  }
  return null;
};

const send = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  let value = '';
  req.on('data', part => {
    value += part;
    if (value.length > 200000) req.destroy();
  });
  req.on('end', () => {
    try {
      resolve(JSON.parse(value || '{}'));
    } catch {
      reject(new Error('Invalid JSON request body.'));
    }
  });
  req.on('error', reject);
});

const readJson = async file => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return [];
  }
};

const escapePython = value => JSON.stringify(value);

function harness(tests) {
  return `import json, traceback
from solution import Solution
tests = ${escapePython(tests)}
results = []
try:
    solver = Solution()
    for test in tests:
        actual = solver.twoSum(list(test['nums']), int(test['target']))
        # Normalize response if list
        if isinstance(actual, (list, tuple)):
            actual = list(actual)
        ok = (actual == test['expected'])
        results.append({
            'passed': ok,
            'input': {'nums': test['nums'], 'target': test['target']},
            'expected': test['expected'],
            'actual': actual if isinstance(actual, (str, int, float, bool, list, dict, type(None))) else str(actual)
        })
    print(json.dumps({'ok': all(item['passed'] for item in results), 'results': results}))
except Exception:
    print(json.dumps({'ok': False, 'error': traceback.format_exc()}))
`;
}

async function runInSandbox(code, tests) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cyber-hunt-'));
  try {
    await fs.writeFile(path.join(folder, 'solution.py'), 'from typing import List, Dict, Tuple, Optional, Any\n' + code, 'utf8');
    await fs.writeFile(path.join(folder, 'harness.py'), harness(tests), 'utf8');

    let output;
    if (dockerAvailable()) {
      output = await new Promise(resolve => {
        const args = [
          'run', '--rm', '--network', 'none', '--read-only',
          '--user', '65534:65534', '--memory', '128m', '--memory-swap', '128m',
          '--cpus', '.5', '--pids-limit', '64', '--security-opt', 'no-new-privileges',
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
          '-v', `${folder}:/workspace:ro`,
          '-w', '/workspace',
          'python:3.12-alpine', 'python', 'harness.py'
        ];
        const proc = spawn('docker', args, { windowsHide: true });
        let stdout = '', stderr = '', timedOut = false;
        proc.stdout.on('data', data => stdout += data);
        proc.stderr.on('data', data => stderr += data);
        const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 3500);
        proc.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }); });
        proc.on('error', error => { clearTimeout(timer); resolve({ stderr: error.message, timedOut: false }); });
      });
    } else {
      const pyCmd = getPythonCommand();
      if (!pyCmd) {
        return { configurationError: 'Python 3 is required for code execution. Please ensure Python 3 is installed.' };
      }
      output = await new Promise(resolve => {
        const proc = spawn(pyCmd, ['harness.py'], { cwd: folder, windowsHide: true });
        let stdout = '', stderr = '', timedOut = false;
        proc.stdout.on('data', data => stdout += data);
        proc.stderr.on('data', data => stderr += data);
        const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 3500);
        proc.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }); });
        proc.on('error', error => { clearTimeout(timer); resolve({ stderr: error.message, timedOut: false }); });
      });
    }

    if (output.timedOut) return { error: 'Execution timed out after 3 seconds.' };
    try {
      const lines = output.stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines.at(-1) || '{}';
      return JSON.parse(lastLine);
    } catch {
      return { error: output.stderr || output.stdout || 'Sandbox did not return a valid result.' };
    }
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

async function recordSubmission(participant, code, result, solved) {
  const all = await readJson(submissionsFile);
  const previousSolved = all.some(item => item.participant === participant && item.challenge === challenge.id && item.solved);
  const awarded = solved && !previousSolved ? challenge.points : 0;
  all.push({
    participant,
    challenge: challenge.id,
    code,
    timestamp: new Date().toISOString(),
    result,
    solved,
    awarded
  });
  await fs.writeFile(submissionsFile, JSON.stringify(all, null, 2));
  return awarded;
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    return res.end();
  }

  // Challenge and Submissions
  if (req.method === 'GET' && url.pathname === '/api/challenges/two-sum') {
    const { hiddenTests, ...publicChallenge } = challenge;
    return send(res, 200, publicChallenge);
  }

  if (req.method === 'GET' && url.pathname === '/api/submissions') {
    const participant = url.searchParams.get('participant');
    const list = (await readJson(submissionsFile))
      .filter(item => !participant || item.participant === participant);
    return send(res, 200, list);
  }

  if (req.method === 'POST' && ['/api/challenges/two-sum/run', '/api/challenges/two-sum/submit'].includes(url.pathname)) {
    try {
      const { code, participant } = await readBody(req);
      if (typeof code !== 'string' || !code.trim()) {
        return send(res, 400, { error: 'Code is required.' });
      }
      if (!participant) {
        return send(res, 401, { error: 'Please log in before running a challenge.' });
      }

      const isSubmit = url.pathname.endsWith('/submit');
      const outcome = await runInSandbox(code, isSubmit ? [...challenge.publicTests, ...challenge.hiddenTests] : challenge.publicTests);

      if (outcome.configurationError) return send(res, 503, outcome);
      if (outcome.error) return send(res, 422, outcome);

      const solved = Boolean(outcome.ok);
      const awarded = isSubmit ? await recordSubmission(participant, code, outcome, solved) : 0;
      const { results, ...summary } = outcome;

      return send(res, 200, {
        ...summary,
        solved: isSubmit && solved,
        awarded,
        visibleResults: results?.slice(0, challenge.publicTests.length)
      });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  // Static File Serving
  if (req.method === 'GET') {
    const relative = url.pathname === '/' ? 'landing.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    
    // Guard internal server files
    if (['challenge-data.json', 'submissions.json'].includes(relative)) {
      return send(res, 403, { error: 'Protected challenge data.' });
    }

    const file = path.resolve(root, relative);
    if (!file.startsWith(root)) return send(res, 403, { error: 'Forbidden' });
    try {
      const content = await fs.readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      return res.end(content);
    } catch {
      return send(res, 404, { error: 'Not found' });
    }
  }

  return send(res, 405, { error: 'Method not allowed' });
});

server.listen(3000, async () => {
  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, JSON.stringify(challenge, null, 2));
  }
  console.log('Cyber Hunt server listening on http://localhost:3000');
});

setInterval(() => {}, 1000 * 60 * 60);
