// ============================================================
// QG (Question Generator) - Namespaced Application Module
// Extracted from QuestionGenerator/index.html
// ============================================================
var QG = {};

// ============================================================
// 配置
// ============================================================
QG.STORAGE_KEY = 'math_records';
QG.API_KEY_KEY = 'math_api_key';

// ============================================================
// 数据层
// ============================================================
QG.useServer = false;

QG._authHeaders = function() {
  var token = localStorage.getItem('ebbinghaus_token') || '';
  if (token) {
    return { 'Authorization': 'Bearer ' + token };
  }
  return {};
};

QG._authFetch = function(url, options) {
  options = options || {};
  options.headers = options.headers || {};
  var auth = QG._authHeaders();
  if (auth.Authorization) {
    options.headers['Authorization'] = auth.Authorization;
  }
  return fetch(url, options);
};

QG.loadRecords = async function() {
  if (QG.useServer) {
    try {
      const res = await QG._authFetch('/api/question/records', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const records = data.records || [];
        localStorage.setItem(QG.STORAGE_KEY, JSON.stringify(records));
        return records;
      }
    } catch (e) { /* 服务器不可用，走本地回退 */ }
  }
  try {
    return JSON.parse(localStorage.getItem(QG.STORAGE_KEY)) || [];
  } catch { return []; }
};

QG.saveRecords = async function(records) {
  localStorage.setItem(QG.STORAGE_KEY, JSON.stringify(records));
  if (QG.useServer) {
    try {
      await QG._authFetch('/api/question/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records }),
      });
    } catch (e) { /* 静默失败 */ }
  }
};

QG.getApiKey = function() {
  return localStorage.getItem(QG.API_KEY_KEY) || '';
};

// ============================================================
// 服务器检测
// ============================================================
QG.serverDetectionPromise = null;

QG.detectServer = async function() {
  try {
    const res = await fetch('/api/ping');
    if (res.ok) {
      QG.useServer = true;
      console.log('[Server] 已连接本地服务器');
    } else {
      QG.useServer = false;
    }
  } catch (e) {
    QG.useServer = false;
    console.log('[Server] 未检测到本地服务器，使用浏览器直连模式');
  }
};

// 等待服务器检测完成（给 generateQuestion 调用）
QG.ensureServerDetected = async function() {
  if (QG.serverDetectionPromise) {
    await QG.serverDetectionPromise;
  }
};

// ============================================================
// Toast
// ============================================================
QG.toastTimer = null;
QG.showToast = function(msg) {
  const el = document.getElementById('qgToast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(QG.toastTimer);
  QG.toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
};

// ============================================================
// 核心：生成题目
// ============================================================
QG.currentQuestion = null; // { question, expression, answer, answerType, solution }
QG.answered = false;
QG.questionStartTime = 0; // 题目开始时间（毫秒时间戳）
QG.questionType = 'mixed'; // 'mixed' | 'decimal' | 'fraction' | 'matrix' | 'equation' | 'inverse'

QG.generateQuestion = async function() {
  // 等待服务器检测完成
  await QG.ensureServerDetected();

  const area = document.getElementById('qgPracticeArea');
  area.innerHTML = '<div class="qg-loading"><div class="qg-spinner"></div>AI 正在出题...</div>';

  try {
    let data;
    if (QG.useServer) {
      // Server mode - apiKey is handled server-side
      // Just send the request without apiKey in the body
      const res = await QG._authFetch('/api/question/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionType: QG.questionType }),
      });
      if (!res.ok) {
        const err = await res.json();
        area.innerHTML = '<div class="qg-card" style="text-align:center;padding:40px;">' +
          '<div style="font-size:40px;margin-bottom:12px;">😅</div>' +
          '<p style="color:#EF4444;font-weight:600;">' + (err.error || '生成失败') + '</p>' +
          '<button class="btn btn-primary" style="margin-top:16px;" onclick="QG.generateQuestion()">重试</button></div>';
        return;
      }
      data = await res.json();
      console.log('[DEBUG] Server response:', JSON.stringify(data).slice(0, 500));
    } else {
      // Browser mode still needs apiKey from localStorage
      const apiKey = QG.getApiKey();
      if (!apiKey) {
        QG.showToast('请先在设置页配置 API Key');
        return;
      }
      // 浏览器模式：直接调用 DeepSeek API
      data = await QG.callDeepSeekDirect(apiKey, QG.questionType);
    }

    if (!data || data.error) {
      area.innerHTML = '<div class="qg-card" style="text-align:center;padding:40px;">' +
        '<div style="font-size:40px;margin-bottom:12px;">😅</div>' +
        '<p style="color:#EF4444;font-weight:600;">' + (data?.error || '生成失败，请重试') + '</p>' +
        '<button class="btn btn-primary" style="margin-top:16px;" onclick="QG.generateQuestion()">重试</button></div>';
      return;
    }

    QG.currentQuestion = data;
    QG.answered = false;
    QG.questionStartTime = Date.now();
    QG.renderQuestion();
  } catch (e) {
    area.innerHTML = '<div class="qg-card" style="text-align:center;padding:40px;">' +
      '<div style="font-size:40px;margin-bottom:12px;">😅</div>' +
      '<p style="color:#EF4444;font-weight:600;">网络错误，请检查网络连接</p>' +
      '<button class="btn btn-primary" style="margin-top:16px;" onclick="QG.generateQuestion()">重试</button></div>';
  }
};

// 浏览器模式直接调用 DeepSeek
QG.callDeepSeekDirect = async function(apiKey, type) {
  if (type === 'matrix') return QG.callDeepSeekDirectMatrix(apiKey);
  if (type === 'equation') return QG.callDeepSeekDirectEquation(apiKey);
  if (type === 'inverse') return QG.callDeepSeekDirectInverse(apiKey);

  const prompt = `你是一个口算题生成器。请生成一道符合以下全部约束的口算题：

数字约束：
- 题目中出现的每个数字最多2位（包括整数部分和小数部分）
- 例如允许：5, 63, 13.2, 23, 23.3, 32/3, 32/63
- 例如不允许：123, 1.234, 123/456

运算约束：
- 最多2个加法(+)、2个减法(-)、2个乘法(×)、2个除法(÷)
- 可以使用括号改变运算顺序
- 运算符总数不超过8个

结果约束：
- 计算结果必须在 -1000 到 1000 之间
- 如果是小数，小数点后最多3位
- 如果是分数，分子和分母各自最多3位数字

类型一致性（重要！）：
- 题目中不能同时出现小数和分数，只能选择一种
- 如果题目中有分数（如 2/3），答案必须用最简分数表示（如 1/2 而非 2/4）
- 如果题目中有小数（如 1.5），答案必须用小数表示
- 如果题目中只有整数，答案用整数表示

请严格按以下 JSON 格式返回，不要包含其他内容：
{
  "question": "题目文本（用 × 和 ÷ 符号）",
  "expression": "可用于 Python eval 的表达式（用 * 和 /）",
  "answer": "标准答案（如 68 或 697/63 或 23.456）",
  "answerType": "integer | decimal | fraction",
  "solution": "详细的解题步骤，用中文，分步说明，每步单独一行"
}`;

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    return { error: 'API 返回 ' + res.status + '，请检查 API Key' };
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return { error: 'AI 返回为空' };

  // 解析 JSON
  let json;
  if (content.startsWith('{')) {
    try { json = JSON.parse(content); } catch (e) {}
  }
  if (!json) {
    const m = content.match(/```(?:json)?\s*\n?(.*?)\n?```/s);
    if (m) {
      try { json = JSON.parse(m[1].trim()); } catch (e) {}
    }
  }
  if (!json || !json.question || !json.expression) {
    return { error: 'AI 返回格式错误，请重试' };
  }
  return json;
};

// 浏览器模式：矩阵乘法
QG.callDeepSeekDirectMatrix = async function(apiKey) {
  const prompt = `你是一个矩阵乘法出题器。请生成一道矩阵乘法题。

约束：
- 矩阵A的维度为 m×n，矩阵B的维度为 n×l
- m, n, l 各自在 1 到 3 之间
- 矩阵中的每个数字都是 -10 到 10 之间的整数，不允许小数或分数
- 结果矩阵的每个元素不能超过3位数字

请严格按以下 JSON 格式返回，不要包含其他内容：
{
  "question": "计算矩阵 A × B",
  "matrixA": [[每行用逗号分隔, 如 [1,2],[3,4]]],
  "matrixB": [[每行用逗号分隔]],
  "answer": [[计算结果的每一行]],
  "rows": m,
  "cols": l,
  "innerDim": n,
  "solution": "详细的解题步骤，每步单独一行，说明每个元素的计算过程"
}`;

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1500,
    }),
  });

  if (!res.ok) {
    return { error: 'API 返回 ' + res.status + '，请检查 API Key' };
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return { error: 'AI 返回为空' };

  // 解析 JSON
  let json;
  if (content.startsWith('{')) {
    try { json = JSON.parse(content); } catch (e) {}
  }
  if (!json) {
    const m = content.match(/```(?:json)?\s*\n?(.*?)\n?```/s);
    if (m) {
      try { json = JSON.parse(m[1].trim()); } catch (e) {}
    }
  }
  if (!json || !json.matrixA || !json.matrixB) {
    return { error: 'AI 返回格式错误，请重试' };
  }
  return json;
};

// 浏览器模式：方程组求解
QG.callDeepSeekDirectEquation = async function(apiKey) {
  const prompt = `你是一个线性方程组出题器。请生成一道线性方程组求解题。

约束：
- 方程组为二元（2个方程2个未知数）或三元（3个方程3个未知数）
- 系数矩阵中的每个数字必须在 -10 到 10 之间（整数）
- 等号右侧的常数项也必须在 -10 到 10 之间（整数）
- 解向量（未知数的值）必须在 -10 到 10 之间（整数）

解题方法要求：
- 请使用**行变换（高斯消元）**方法求解，将增广矩阵化为行最简形
- 解题步骤必须详细，每步写出变换操作（如 R2 = R2 - 2×R1）和当前增广矩阵的状态
- 最后一步给出单位矩阵和解向量

请严格按以下 JSON 格式返回，不要包含其他内容：
{
  "question": "解下列线性方程组",
  "equations": ["方程1的文本", "方程2的文本"],
  "matrixA": [[系数矩阵]],
  "vectorB": [常数项列向量],
  "variables": ["x", "y"],
  "numVars": 2,
  "answer": {"x": 1, "y": 2},
  "solution": "详细的解题步骤，使用行变换方法，每步单独一行"
}`;

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    return { error: 'API 返回 ' + res.status + '，请检查 API Key' };
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return { error: 'AI 返回为空' };

  let json;
  if (content.startsWith('{')) {
    try { json = JSON.parse(content); } catch (e) {}
  }
  if (!json) {
    const m = content.match(/```(?:json)?\s*\n?(.*?)\n?```/s);
    if (m) {
      try { json = JSON.parse(m[1].trim()); } catch (e) {}
    }
  }
  if (!json || !json.equations || !json.matrixA || !json.answer) {
    return { error: 'AI 返回格式错误，请重试' };
  }
  return json;
};

// 浏览器模式：逆矩阵
QG.callDeepSeekDirectInverse = async function(apiKey) {
  const prompt = `你是一个矩阵求逆出题器。请生成一道矩阵求逆题。

约束：
- 生成一个 n×n 方阵 A，其中 n=2 或 n=3
- 矩阵中的每个数字都是 -5 到 5 之间的整数（不要小数或分数）
- 矩阵必须可逆（行列式不为零）
- 逆矩阵的元素可能是分数

请严格按以下 JSON 格式返回，不要包含其他内容：
{
  "question": "求矩阵 A 的逆矩阵",
  "matrixA": [[矩阵的每一行]],
  "size": 2,
  "answer": [[逆矩阵的每一行]],
  "solution": "详细的解题步骤，使用行变换方法 [A|I] → [I|A^(-1)]，每步单独一行"
}`;

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1500,
    }),
  });

  if (!res.ok) {
    return { error: 'API 返回 ' + res.status + '，请检查 API Key' };
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return { error: 'AI 返回为空' };

  let json;
  if (content.startsWith('{')) {
    try { json = JSON.parse(content); } catch (e) {}
  }
  if (!json) {
    const m = content.match(/```(?:json)?\s*\n?(.*?)\n?```/s);
    if (m) {
      try { json = JSON.parse(m[1].trim()); } catch (e) {}
    }
  }
  if (!json || !json.matrixA || !json.answer) {
    return { error: 'AI 返回格式错误，请重试' };
  }
  return json;
};

QG.renderQuestion = function() {
  if (!QG.currentQuestion) return;
  const area = document.getElementById('qgPracticeArea');

  if (QG.currentQuestion.questionType === 'inverse') {
    QG.renderInverseQuestion();
    return;
  }

  if (QG.currentQuestion.questionType === 'equation' || QG.currentQuestion.equations) {
    QG.renderEquationQuestion();
    return;
  }

  if (QG.currentQuestion.matrixA && QG.currentQuestion.matrixB) {
    QG.renderMatrixQuestion();
    return;
  }

  area.innerHTML =
    '<div class="card question-area">' +
      '<div class="qg-question-text">' + QG.escapeHtml(QG.currentQuestion.question) + '</div>' +
      '<div style="color:#94a3b8;font-size:13px;margin-bottom:12px;">输入你的答案，然后点击提交</div>' +
      '<div class="qg-answer-row">' +
        '<input type="text" id="qgAnswerInput" placeholder="?" autocomplete="off" onkeydown="if(event.key===\'Enter\')QG.submitAnswer()">' +
        '<button class="btn btn-success qg-submit-btn" onclick="QG.submitAnswer()">提交</button>' +
      '</div>' +
      '<div id="qgResultArea"></div>' +
    '</div>';

  document.getElementById('qgAnswerInput').focus();
};

// ============================================================
// 矩阵渲染
// ============================================================
QG.renderMatrixQuestion = function() {
  if (!QG.currentQuestion) return;
  const q = QG.currentQuestion;
  const rows = q.rows || q.matrixA.length;
  const cols = q.cols || q.matrixB[0].length;
  const innerDim = q.innerDim || q.matrixA[0].length;

  let html = '<div class="card matrix-area">';
  html += '<div class="qg-question-text" style="font-size:22px;">' + QG.escapeHtml(q.question || '计算矩阵 A × B') + '</div>';

  // 矩阵 A × 矩阵 B = 用户输入矩阵
  html += '<div class="qg-matrix-row">';
  html += '<div><div class="qg-matrix-label">A</div>' + QG.renderMatrixTable(q.matrixA) + '</div>';
  html += '<span class="qg-matrix-op">×</span>';
  html += '<div><div class="qg-matrix-label">B</div>' + QG.renderMatrixTable(q.matrixB) + '</div>';
  html += '<span class="qg-matrix-op">=</span>';
  // 用户输入的答案矩阵
  html += '<div><div class="qg-matrix-label">结果</div>' + QG.renderMatrixInputs(rows, cols) + '</div>';
  html += '</div>';

  html += '<div style="color:#94a3b8;font-size:13px;margin-top:8px;margin-bottom:12px;">在结果矩阵中填入每个元素的值</div>';
  html += '<div><button class="btn btn-success qg-submit-btn" onclick="QG.submitMatrixAnswer()">提交</button></div>';
  html += '<div id="qgResultArea"></div>';
  html += '</div>';

  document.getElementById('qgPracticeArea').innerHTML = html;

  // 聚焦第一个输入框
  const firstInput = document.querySelector('.qg-matrix-box input');
  if (firstInput) firstInput.focus();
};

QG.renderMatrixTable = function(matrix) {
  if (!matrix || !matrix.length) return '';
  let html = '<div class="qg-matrix-box"><table>';
  for (let i = 0; i < matrix.length; i++) {
    html += '<tr>';
    for (let j = 0; j < matrix[i].length; j++) {
      html += '<td>' + QG.escapeHtml('' + matrix[i][j]) + '</td>';
    }
    html += '</tr>';
  }
  html += '</table></div>';
  return html;
};

QG.renderMatrixInputs = function(rows, cols) {
  let html = '<div class="qg-matrix-box"><table id="qgMatrixInputTable">';
  for (let i = 0; i < rows; i++) {
    html += '<tr>';
    for (let j = 0; j < cols; j++) {
      html += '<td><input type="text" class="qg-matrix-cell" data-row="' + i + '" data-col="' + j + '" autocomplete="off"></td>';
    }
    html += '</tr>';
  }
  html += '</table></div>';
  return html;
};

QG.collectMatrixAnswer = function() {
  const inputs = document.querySelectorAll('.qg-matrix-cell');
  const size = QG.currentQuestion.size;
  const rows = size || QG.currentQuestion.rows || QG.currentQuestion.matrixA.length;
  const cols = size || QG.currentQuestion.cols || (QG.currentQuestion.matrixB ? QG.currentQuestion.matrixB[0].length : size);
  const result = [];
  for (let i = 0; i < rows; i++) {
    result[i] = [];
    for (let j = 0; j < cols; j++) {
      const val = document.querySelector('.qg-matrix-cell[data-row="' + i + '"][data-col="' + j + '"]');
      result[i][j] = val ? val.value.trim() : '';
    }
  }
  return result;
};

QG.submitMatrixAnswer = async function() {
  if (!QG.currentQuestion || QG.answered) return;

  const userMatrix = QG.collectMatrixAnswer();
  // 检查是否所有格子都已填写
  for (let i = 0; i < userMatrix.length; i++) {
    for (let j = 0; j < userMatrix[i].length; j++) {
      if (userMatrix[i][j] === '') {
        QG.showToast('请填写所有格子');
        return;
      }
    }
  }

  const btn = document.querySelector('.qg-submit-btn');
  btn.disabled = true;
  btn.textContent = '核验中...';

  let correct = false;
  let exactAnswer = null;

  if (QG.useServer) {
    try {
      const res = await QG._authFetch('/api/question/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionType: 'matrix',
          matrixA: QG.currentQuestion.matrixA,
          matrixB: QG.currentQuestion.matrixB,
          userAnswer: userMatrix,
        }),
      });
      const data = await res.json();
      correct = data.correct;
      exactAnswer = data.computedAnswer || data.exactAnswer;
    } catch (e) {
      correct = QG.clientVerifyMatrix(userMatrix, QG.currentQuestion.answer);
    }
  } else {
    correct = QG.clientVerifyMatrix(userMatrix, QG.currentQuestion.answer);
  }

  QG.answered = true;
  const elapsedSec = Math.round((Date.now() - QG.questionStartTime) / 1000);

  // 保存记录
  const records = await QG.loadRecords();
  records.push({
    id: Date.now() + Math.random(),
    question: QG.currentQuestion.question || '矩阵乘法',
    expression: JSON.stringify({ matrixA: QG.currentQuestion.matrixA, matrixB: QG.currentQuestion.matrixB }),
    userAnswer: JSON.stringify(userMatrix),
    correctAnswer: exactAnswer ? JSON.stringify(exactAnswer) : JSON.stringify(QG.currentQuestion.answer),
    solution: QG.currentQuestion.solution || '',
    correct: correct,
    speedSec: elapsedSec,
    timestamp: new Date().toISOString(),
    questionType: 'matrix',
  });
  await QG.saveRecords(records);

  // 显示结果
  QG.displayMatrixResult(correct, userMatrix, exactAnswer || QG.currentQuestion.answer);

  btn.textContent = '已提交';
  QG.updateStats();
};

QG.displayMatrixResult = function(correct, userMatrix, correctMatrix) {
  const resultArea = document.getElementById('qgResultArea');

  if (correct) {
    resultArea.innerHTML =
      '<div class="result-badge correct">✅ 正确！</div>' +
      '<div style="margin:12px 0;"><div class="qg-matrix-label">正确结果</div>' + QG.renderMatrixTable(correctMatrix) + '</div>';
  } else {
    resultArea.innerHTML =
      '<div class="result-badge wrong">❌ 错误</div>' +
      '<div style="margin:12px 0;"><div class="qg-matrix-label">正确结果</div>' + QG.renderMatrixTable(correctMatrix) + '</div>' +
      '<div style="margin:12px 0;"><div class="qg-matrix-label">你的输入</div>' + QG.renderMatrixTable(userMatrix) + '</div>';
  }

  // 逐个格子高亮
  const rows = correctMatrix.length;
  const cols = correctMatrix[0].length;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const input = document.querySelector('.qg-matrix-cell[data-row="' + i + '"][data-col="' + j + '"]');
      if (input) {
        const userVal = input.value.trim();
        const correctVal = '' + correctMatrix[i][j];
        if (userVal === correctVal) {
          input.className = 'qg-matrix-cell correct';
        } else {
          input.className = 'qg-matrix-cell wrong';
        }
      }
    }
  }

  // solution + 下一题
  resultArea.innerHTML +=
    '<div class="qg-solution-box">' +
      '<h3>📖 详细解答</h3>' +
      '<div class="qg-step">' + QG.escapeHtml(QG.currentQuestion.solution || '') + '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">' +
      '<button class="btn btn-primary" onclick="QG.generateQuestion()">继续下一题 →</button>' +
      '<button class="btn btn-outline" onclick="QG.endPractice()">结束做题</button>' +
    '</div>';
};

QG.parseNumericValue = function(str) {
  if (typeof str === 'number') return str;
  str = str.trim();
  if (str.includes('/')) {
    const parts = str.split('/');
    return parseFloat(parts[0]) / parseFloat(parts[1]);
  }
  return parseFloat(str);
};

QG.clientVerifyMatrix = function(userMatrix, correctMatrix) {
  if (!userMatrix || !correctMatrix) return false;
  if (userMatrix.length !== correctMatrix.length) return false;
  for (let i = 0; i < userMatrix.length; i++) {
    if (userMatrix[i].length !== correctMatrix[i].length) return false;
    for (let j = 0; j < userMatrix[i].length; j++) {
      if (Math.abs(QG.parseNumericValue(userMatrix[i][j]) - QG.parseNumericValue(correctMatrix[i][j])) > 0.001) return false;
    }
  }
  return true;
};

// ============================================================
// 结构化解题步骤渲染（含左乘矩阵）
// ============================================================
QG.renderStructuredMatrix = function(matrix) {
  if (!matrix || !matrix.length) return '';
  let html = '<div class="qg-matrix-box"><table>';
  for (let i = 0; i < matrix.length; i++) {
    html += '<tr>';
    for (let j = 0; j < matrix[i].length; j++) {
      html += '<td>' + QG.escapeHtml(matrix[i][j]) + '</td>';
    }
    html += '</tr>';
  }
  html += '</table></div>';
  return html;
};

QG.renderAugmentedMatrix = function(matrix, vector) {
  if (!matrix || !matrix.length) return '';
  const n = matrix.length;
  let html = '<div class="qg-matrix-box augmented"><table>';
  for (let i = 0; i < n; i++) {
    html += '<tr>';
    for (let j = 0; j < n; j++) {
      html += '<td>' + QG.escapeHtml(matrix[i][j]) + '</td>';
    }
    html += '<td class="qg-vert-bar"></td>';
    html += '<td>' + QG.escapeHtml(vector[i]) + '</td>';
    html += '</tr>';
  }
  html += '</table></div>';
  return html;
};

QG.renderEquationSteps = function(steps) {
  if (!steps || !steps.length) return '';
  let html = '<div class="qg-eq-steps">';
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    html += '<div class="qg-eq-step">';
    html += '<div class="qg-eq-step-header">第 ' + (s + 1) + ' 步: ' + QG.escapeHtml(step.operation) + '</div>';
    html += '<div class="qg-eq-step-matrices">';
    if (step.leftMatrix) {
      html += '<div class="qg-matrix-block">' +
        '<div class="qg-matrix-label">左乘矩阵</div>' +
        QG.renderStructuredMatrix(step.leftMatrix) +
        '</div>';
    }
    if (step.augmented) {
      html += '<div class="qg-eq-step-arrow">→</div>';
      // 判断右侧是向量（方程组）还是方阵（逆矩阵）
      const vec = step.augmented.vector;
      if (vec && Array.isArray(vec) && vec.length > 0 && Array.isArray(vec[0])) {
        // 右侧是方阵（逆矩阵 [A|I] 格式）
        html += '<div class="qg-matrix-block">' +
          '<div class="qg-matrix-label">增广矩阵</div>' +
          QG.renderAugmentedMatrixSquare(step.augmented.matrix, vec) +
          '</div>';
      } else {
        // 右侧是向量（方程组 [A|b] 格式）
        html += '<div class="qg-matrix-block">' +
          '<div class="qg-matrix-label">增广矩阵</div>' +
          QG.renderAugmentedMatrix(step.augmented.matrix, step.augmented.vector) +
          '</div>';
      }
    }
    html += '</div>'; // eq-step-matrices
    html += '</div>'; // eq-step
  }
  html += '</div>';
  return html;
};

QG.renderAugmentedMatrixSquare = function(matrix, rightMatrix) {
  /* 渲染 [A | B] 格式，左右都是方阵 */
  if (!matrix || !matrix.length || !rightMatrix) return '';
  const n = matrix.length;
  let html = '<div class="qg-matrix-box augmented"><table>';
  for (let i = 0; i < n; i++) {
    html += '<tr>';
    for (let j = 0; j < n; j++) {
      html += '<td>' + QG.escapeHtml(matrix[i][j]) + '</td>';
    }
    html += '<td class="qg-vert-bar"></td>';
    for (let j = 0; j < n; j++) {
      html += '<td>' + QG.escapeHtml(rightMatrix[i][j]) + '</td>';
    }
    html += '</tr>';
  }
  html += '</table></div>';
  return html;
};

// ============================================================
// 逆矩阵渲染
// ============================================================
QG.renderInverseQuestion = function() {
  if (!QG.currentQuestion) return;
  const q = QG.currentQuestion;
  const size = q.size || q.matrixA.length;

  let html = '<div class="card matrix-area">';
  html += '<div class="qg-question-text" style="font-size:22px;">' + QG.escapeHtml(q.question || '求矩阵 A 的逆矩阵') + '</div>';

  // 显示矩阵 A
  html += '<div class="qg-matrix-row">';
  html += '<div><div class="qg-matrix-label">A</div>' + QG.renderMatrixTable(q.matrixA) + '</div>';
  html += '<span class="qg-matrix-op">→</span>';
  html += '<div><div class="qg-matrix-label">A⁻¹ = ?</div>' + QG.renderMatrixInputs(size, size) + '</div>';
  html += '</div>';

  html += '<div style="color:#94a3b8;font-size:13px;margin-top:8px;margin-bottom:12px;">在右侧矩阵中填入 A⁻¹ 的每个元素（分数用 a/b 格式）</div>';
  html += '<div><button class="btn btn-success qg-submit-btn" onclick="QG.submitInverseAnswer()">提交</button></div>';
  html += '<div id="qgResultArea"></div>';
  html += '</div>';

  document.getElementById('qgPracticeArea').innerHTML = html;

  // 聚焦第一个输入框
  const firstInput = document.querySelector('.qg-matrix-cell');
  if (firstInput) firstInput.focus();
};

QG.submitInverseAnswer = async function() {
  if (!QG.currentQuestion || QG.answered) return;

  const userMatrix = QG.collectMatrixAnswer();
  const size = QG.currentQuestion.size || QG.currentQuestion.matrixA.length;

  // 检查所有格子都已填写
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if (userMatrix[i][j] === '') {
        QG.showToast('请填写所有格子');
        return;
      }
    }
  }

  const btn = document.querySelector('.qg-submit-btn');
  btn.disabled = true;
  btn.textContent = '核验中...';

  let correct = false;
  let serverAnswer = null;

  if (QG.useServer) {
    try {
      const res = await QG._authFetch('/api/question/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionType: 'inverse',
          matrixA: QG.currentQuestion.matrixA,
          userAnswer: userMatrix,
          size: size,
        }),
      });
      const data = await res.json();
      correct = data.correct;
    } catch (e) {
      // 降级到本地验证
      correct = QG.clientVerifyMatrix(userMatrix, QG.currentQuestion.answer);
    }
  } else {
    correct = QG.clientVerifyMatrix(userMatrix, QG.currentQuestion.answer);
  }

  QG.answered = true;
  const elapsedSec = Math.round((Date.now() - QG.questionStartTime) / 1000);

  // 保存记录
  const records = await QG.loadRecords();
  records.push({
    id: Date.now() + Math.random(),
    question: '逆矩阵: ' + JSON.stringify(QG.currentQuestion.matrixA),
    expression: JSON.stringify({ matrixA: QG.currentQuestion.matrixA }),
    userAnswer: JSON.stringify(userMatrix),
    correctAnswer: JSON.stringify(QG.currentQuestion.answer),
    solution: QG.currentQuestion.solution || '',
    correct: correct,
    speedSec: elapsedSec,
    timestamp: new Date().toISOString(),
    questionType: 'inverse',
  });
  await QG.saveRecords(records);

  QG.displayInverseResult(correct, userMatrix, QG.currentQuestion.answer);

  btn.textContent = '已提交';
  QG.updateStats();
};

QG.displayInverseResult = function(correct, userMatrix, correctMatrix) {
  const resultArea = document.getElementById('qgResultArea');

  if (correct) {
    resultArea.innerHTML =
      '<div class="result-badge correct">✅ 正确！</div>' +
      '<div style="margin:12px 0;"><div class="qg-matrix-label">A⁻¹</div>' + QG.renderMatrixTable(correctMatrix) + '</div>';
  } else {
    resultArea.innerHTML =
      '<div class="result-badge wrong">❌ 错误</div>' +
      '<div style="margin:12px 0;"><div class="qg-matrix-label">A⁻¹</div>' + QG.renderMatrixTable(correctMatrix) + '</div>' +
      '<div style="margin:12px 0;"><div class="qg-matrix-label">你的输入</div>' + QG.renderMatrixTable(userMatrix) + '</div>';
  }

  // 逐个格子高亮
  const size = correctMatrix.length;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const input = document.querySelector('.qg-matrix-cell[data-row="' + i + '"][data-col="' + j + '"]');
      if (input) {
        const userVal = input.value.trim();
        const correctVal = '' + correctMatrix[i][j];
        if (userVal === correctVal) {
          input.className = 'qg-matrix-cell correct';
        } else {
          input.className = 'qg-matrix-cell wrong';
        }
      }
    }
  }

  // solution + 下一题
  let solutionHtml;
  if (QG.currentQuestion.solutionSteps) {
    solutionHtml = '<div class="qg-solution-box">' +
      '<h3>📖 详细解答（行变换求逆 · 含左乘矩阵）</h3>' +
      QG.renderEquationSteps(QG.currentQuestion.solutionSteps) +
    '</div>';
  } else {
    solutionHtml = '<div class="qg-solution-box">' +
      '<h3>📖 详细解答（行变换求逆）</h3>' +
      '<div class="qg-step">' + QG.escapeHtml(QG.currentQuestion.solution || '') + '</div>' +
    '</div>';
  }
  resultArea.innerHTML += solutionHtml +
    '<div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">' +
      '<button class="btn btn-primary" onclick="QG.generateQuestion()">继续下一题 →</button>' +
      '<button class="btn btn-outline" onclick="QG.endPractice()">结束做题</button>' +
    '</div>';
};

// ============================================================
// 方程组渲染
// ============================================================
QG.renderEquationQuestion = function() {
  if (!QG.currentQuestion) return;
  const q = QG.currentQuestion;
  const vars = q.variables || ['x', 'y'];
  const n = q.numVars || vars.length;

  let html = '<div class="card matrix-area">';
  html += '<div class="qg-question-text" style="font-size:20px;">' + QG.escapeHtml(q.question || '解下列线性方程组') + '</div>';

  // 显示方程组
  html += '<div style="text-align:left;margin:16px auto;padding:16px 20px;background:#f8faff;border-radius:var(--radius);border:2px solid #eef2ff;font-size:17px;font-weight:600;line-height:2;display:inline-block;">';
  (q.equations || []).forEach(function(eq) {
    html += QG.escapeHtml(eq) + '<br>';
  });
  html += '</div>';

  // 输入框
  html += '<div style="color:#94a3b8;font-size:13px;margin-bottom:12px;">请输入每个未知数的值</div>';
  html += '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-bottom:16px;">';
  vars.forEach(function(v, idx) {
    html += '<div style="display:flex;align-items:center;gap:6px;">' +
      '<label style="font-size:18px;font-weight:700;color:#1e293b;">' + QG.escapeHtml(v) + ' =</label>' +
      '<input type="text" id="eq-var-' + idx + '" class="qg-eq-input" data-var="' + QG.escapeHtml(v) + '" style="width:80px;padding:8px 10px;border:2px solid #e2e8f0;border-radius:6px;font-size:18px;font-weight:700;text-align:center;outline:none;background:#f8fafc;" autocomplete="off">' +
      '</div>';
  });
  html += '</div>';

  html += '<div><button class="btn btn-success qg-submit-btn" onclick="QG.submitEquationAnswer()">提交</button></div>';
  html += '<div id="qgResultArea"></div>';
  html += '</div>';

  document.getElementById('qgPracticeArea').innerHTML = html;

  // 聚焦第一个输入框
  const firstInput = document.querySelector('.qg-eq-input');
  if (firstInput) firstInput.focus();
};

QG.collectEquationAnswer = function() {
  const vars = QG.currentQuestion.variables || ['x', 'y'];
  const result = {};
  vars.forEach(function(v, idx) {
    const input = document.getElementById('eq-var-' + idx);
    result[v] = input ? input.value.trim() : '';
  });
  return result;
};

QG.submitEquationAnswer = async function() {
  if (!QG.currentQuestion || QG.answered) return;

  const userAnswer = QG.collectEquationAnswer();
  const vars = QG.currentQuestion.variables || ['x', 'y'];

  // 检查是否全部填写
  for (var i = 0; i < vars.length; i++) {
    if (userAnswer[vars[i]] === '') {
      QG.showToast('请填写所有未知数的值');
      return;
    }
  }

  const btn = document.querySelector('.qg-submit-btn');
  btn.disabled = true;
  btn.textContent = '核验中...';

  let correct = false;
  let exactAnswer = null;

  if (QG.useServer) {
    try {
      const res = await QG._authFetch('/api/question/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionType: 'equation',
          correctAnswer: QG.currentQuestion.answer,
          userAnswer: userAnswer,
          variables: vars,
        }),
      });
      const data = await res.json();
      correct = data.correct;
      exactAnswer = data.exactAnswer || QG.currentQuestion.answer;
    } catch (e) {
      correct = QG.clientVerifyEquation(userAnswer, QG.currentQuestion.answer, vars);
    }
  } else {
    correct = QG.clientVerifyEquation(userAnswer, QG.currentQuestion.answer, vars);
  }

  QG.answered = true;
  const elapsedSec = Math.round((Date.now() - QG.questionStartTime) / 1000);

  // 保存记录
  const records = await QG.loadRecords();
  records.push({
    id: Date.now() + Math.random(),
    question: (QG.currentQuestion.equations || ['方程组']).join('; '),
    expression: JSON.stringify({ matrixA: QG.currentQuestion.matrixA, vectorB: QG.currentQuestion.vectorB }),
    userAnswer: JSON.stringify(userAnswer),
    correctAnswer: JSON.stringify(exactAnswer),
    solution: QG.currentQuestion.solution || '',
    correct: correct,
    speedSec: elapsedSec,
    timestamp: new Date().toISOString(),
    questionType: 'equation',
  });
  await QG.saveRecords(records);

  // 显示结果
  QG.displayEquationResult(correct, userAnswer, exactAnswer || QG.currentQuestion.answer, vars);

  btn.textContent = '已提交';
  QG.updateStats();
};

QG.displayEquationResult = function(correct, userAnswer, correctAnswer, vars) {
  const resultArea = document.getElementById('qgResultArea');

  let userStr = vars.map(function(v) { return v + '=' + (userAnswer[v] || '?'); }).join(', ');
  let correctStr = vars.map(function(v) { return v + '=' + (correctAnswer[v] || '?'); }).join(', ');

  if (correct) {
    resultArea.innerHTML =
      '<div class="result-badge correct">✅ 正确！</div>' +
      '<div style="font-size:16px;font-weight:700;color:var(--success);margin:8px 0;">' + QG.escapeHtml(correctStr) + '</div>';
  } else {
    resultArea.innerHTML =
      '<div class="result-badge wrong">❌ 错误</div>' +
      '<div style="font-size:14px;color:#64748b;margin-bottom:8px;">你的答案: <strong style="color:#EF4444;">' + QG.escapeHtml(userStr) + '</strong></div>' +
      '<div style="font-size:14px;color:#64748b;margin-bottom:8px;">正确答案: <strong style="color:var(--success);">' + QG.escapeHtml(correctStr) + '</strong></div>';
  }

  // 逐个输入框高亮
  vars.forEach(function(v, idx) {
    const input = document.getElementById('eq-var-' + idx);
    if (input) {
      if ((input.value.trim()) === '' + (correctAnswer[v] !== undefined ? correctAnswer[v] : '')) {
        input.style.borderColor = 'var(--success)';
        input.style.background = '#f0fdf4';
      } else {
        input.style.borderColor = 'var(--danger)';
        input.style.background = '#fef2f2';
      }
    }
  });

  // solution + 下一题/结束
  let solutionHtml;
  if (QG.currentQuestion.solutionSteps) {
    solutionHtml = '<div class="qg-solution-box">' +
      '<h3>📖 详细解答（行变换 · 含左乘矩阵）</h3>' +
      QG.renderEquationSteps(QG.currentQuestion.solutionSteps) +
    '</div>';
  } else {
    solutionHtml = '<div class="qg-solution-box">' +
      '<h3>📖 详细解答（行变换）</h3>' +
      '<div class="qg-step">' + QG.escapeHtml(QG.currentQuestion.solution || '') + '</div>' +
    '</div>';
  }
  resultArea.innerHTML += solutionHtml +
    '<div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">' +
      '<button class="btn btn-primary" onclick="QG.generateQuestion()">继续下一题 →</button>' +
      '<button class="btn btn-outline" onclick="QG.endPractice()">结束做题</button>' +
    '</div>';
};

QG.clientVerifyEquation = function(userAnswer, correctAnswer, variables) {
  if (!userAnswer || !correctAnswer) return false;
  for (var i = 0; i < variables.length; i++) {
    var v = variables[i];
    var ua = parseInt(userAnswer[v]);
    var ca = parseInt(correctAnswer[v]);
    if (isNaN(ua) || isNaN(ca) || ua !== ca) return false;
  }
  return true;
};

// ============================================================
// 核验答案
// ============================================================
QG.submitAnswer = async function() {
  if (!QG.currentQuestion || QG.answered) return;
  const input = document.getElementById('qgAnswerInput');
  const userAnswer = input.value.trim();
  if (!userAnswer) { QG.showToast('请输入答案'); return; }

  const btn = document.querySelector('.qg-submit-btn');
  btn.disabled = true;
  btn.textContent = '核验中...';

  let correct = false;
  let exactAnswer = QG.currentQuestion.answer;

  if (QG.useServer) {
    // 服务器模式：用 Python Fraction 精确计算
    try {
      const res = await QG._authFetch('/api/question/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expression: QG.currentQuestion.expression,
          userAnswer: userAnswer,
        }),
      });
      const data = await res.json();
      correct = data.correct;
      if (data.exactAnswer) exactAnswer = data.exactAnswer;
    } catch (e) {
      // 降级到客户端验证
      correct = QG.clientVerify(userAnswer, QG.currentQuestion.answer, QG.currentQuestion.expression);
    }
  } else {
    correct = QG.clientVerify(userAnswer, QG.currentQuestion.answer, QG.currentQuestion.expression);
  }

  QG.answered = true;

  // 计算用时（秒）
  const elapsedSec = Math.round((Date.now() - QG.questionStartTime) / 1000);

  // 保存记录
  const records = await QG.loadRecords();
  records.push({
    id: Date.now() + Math.random(),
    question: QG.currentQuestion.question,
    expression: QG.currentQuestion.expression,
    userAnswer: userAnswer,
    correctAnswer: exactAnswer,
    solution: QG.currentQuestion.solution || '',
    correct: correct,
    speedSec: elapsedSec,
    timestamp: new Date().toISOString(),
    questionType: QG.currentQuestion.questionType || QG.questionType,
  });
  await QG.saveRecords(records);

  // 显示结果
  const resultArea = document.getElementById('qgResultArea');
  const inputEl = document.getElementById('qgAnswerInput');

  if (correct) {
    inputEl.className = 'correct';
    resultArea.innerHTML =
      '<div class="result-badge correct">✅ 正确！</div>' +
      '<div class="qg-solution-box">' +
        '<h3>📖 详细解答</h3>' +
        '<div class="qg-step">' + QG.escapeHtml(QG.currentQuestion.solution) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">' +
        '<button class="btn btn-primary" onclick="QG.generateQuestion()">继续下一题 →</button>' +
        '<button class="btn btn-outline" onclick="QG.endPractice()">结束做题</button>' +
      '</div>';
  } else {
    inputEl.className = 'wrong';
    resultArea.innerHTML =
      '<div class="result-badge wrong">❌ 错误</div>' +
      '<div style="font-size:15px;color:#64748b;margin-bottom:12px;">正确答案：<strong style="color:var(--success);font-size:18px;">' + QG.escapeHtml(exactAnswer) + '</strong></div>' +
      '<div class="qg-solution-box">' +
        '<h3>📖 详细解答</h3>' +
        '<div class="qg-step">' + QG.escapeHtml(QG.currentQuestion.solution) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">' +
        '<button class="btn btn-primary" onclick="QG.generateQuestion()">继续下一题 →</button>' +
        '<button class="btn btn-outline" onclick="QG.endPractice()">结束做题</button>' +
      '</div>';
  }

  btn.textContent = '已提交';
  QG.updateStats();
};

QG.parseNum = function(s) {
  // 将字符串解析为数值，支持分数格式 a/b
  s = s.trim();
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length === 2) {
      const n = parseFloat(parts[0].trim());
      const d = parseFloat(parts[1].trim());
      if (!isNaN(n) && !isNaN(d) && d !== 0) return n / d;
    }
  }
  return parseFloat(s);
};

QG.gcd = function(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) { const t = b; b = a % b; a = t; }
  return a;
};

QG.isSimplestFraction = function(s) {
  // 检查分数字符串是否为最简形式（如 6/5 通过, 12/10 不通过）
  s = s.trim();
  if (!s.includes('/')) return true; // 不是分数，算通过
  const parts = s.split('/');
  if (parts.length !== 2) return true;
  const n = parseInt(parts[0].trim(), 10);
  const d = parseInt(parts[1].trim(), 10);
  if (isNaN(n) || isNaN(d)) return true;
  return QG.gcd(n, d) === 1;
};

QG.clientVerify = function(userAnswer, correctAnswer, expression) {
  // 浏览器端验证：支持分数↔小数等价，拒绝未化简分数
  const ua = userAnswer.trim();
  const ca = correctAnswer.trim();

  // 精确字符串匹配
  if (ua === ca) return true;

  // 如果用户输入的是分数，先检查是否为最简形式
  if (ua.includes('/') && !QG.isSimplestFraction(ua)) return false;

  // 数值比较（支持分数↔小数）
  const uNum = QG.parseNum(ua);
  const cNum = QG.parseNum(ca);
  if (!isNaN(uNum) && !isNaN(cNum)) {
    return Math.abs(uNum - cNum) < 0.001;
  }

  return false;
};

// ============================================================
// 统计 + 服务器同步
// ============================================================
QG.updateStats = async function() {
  const records = await QG.loadRecords();
  const today = new Date().toISOString().slice(0, 10);
  const todayRecords = records.filter(r => r.timestamp && r.timestamp.slice(0, 10) === today);

  document.getElementById('qgStatToday').textContent = todayRecords.length;

  const correct = todayRecords.filter(r => r.correct).length;
  const total = todayRecords.length;
  document.getElementById('qgStatAccuracy').textContent = total === 0 ? '0%' : Math.round(correct / total * 100) + '%';

  // 连续正确（按时间倒序）
  const sorted = [...todayRecords].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  let streak = 0;
  for (const r of sorted) {
    if (r.correct) streak++;
    else break;
  }
  document.getElementById('qgStatStreak').textContent = streak;

  // 平均速度
  const speedRecords = todayRecords.filter(r => r.speedSec != null);
  if (speedRecords.length > 0) {
    const avgSpeed = Math.round(speedRecords.reduce((s, r) => s + r.speedSec, 0) / speedRecords.length);
    document.getElementById('qgStatSpeed').textContent = avgSpeed + 's';
  } else {
    document.getElementById('qgStatSpeed').textContent = '--';
  }

  // 同步统计到服务器
  QG.syncStatsToServer(today, total, correct, speedRecords);

  // 按题型分类统计
  QG.renderTypeStats(todayRecords);
};

QG.renderTypeStats = function(todayRecords) {
  const container = document.getElementById('qgTypeStats');
  const typeLabels = { mixed: '混合', decimal: '小数', fraction: '分数', matrix: '矩阵', equation: '方程组', inverse: '逆矩阵' };

  // 按题型分组
  const byType = {};
  todayRecords.forEach(function(r) {
    const t = r.questionType || 'mixed';
    if (!byType[t]) byType[t] = { total: 0, correct: 0, speeds: [] };
    byType[t].total++;
    if (r.correct) byType[t].correct++;
    if (r.speedSec != null) byType[t].speeds.push(r.speedSec);
  });

  const types = Object.keys(byType);
  if (types.length === 0) {
    container.style.display = 'none';
    return;
  }

  var html = '<div class="qg-type-stats-section">' +
    '<div class="qg-type-stats-title">各题型统计</div>';

  types.forEach(function(t) {
    var d = byType[t];
    var acc = d.total > 0 ? Math.round(d.correct / d.total * 100) : 0;
    var avg = d.speeds.length > 0 ? Math.round(d.speeds.reduce(function(a, b) { return a + b; }, 0) / d.speeds.length) : null;
    var accClass = acc >= 80 ? 'qg-good' : (acc >= 50 ? '' : 'qg-bad');
    html += '<div class="qg-type-stats-row">' +
      '<div class="qg-type-stats-label">' + (typeLabels[t] || t) + '</div>' +
      '<div class="qg-type-stats-nums">' +
        '<span>' + d.total + ' 题</span>' +
        '<span>正确率 <span class="qg-num-val ' + accClass + '">' + acc + '%</span></span>' +
        '<span>平均 ' + (avg !== null ? '<span class="qg-num-val">' + avg + 's</span>' : '--') + '</span>' +
      '</div>' +
    '</div>';
  });

  html += '</div>';
  container.style.display = '';
  container.innerHTML = html;
};

QG.syncStatsToServer = async function(today, total, correct, speedRecords) {
  if (!QG.useServer) return;
  try {
    // 先获取服务器现有统计
    const getRes = await QG._authFetch('/api/question/stats', { cache: 'no-store' });
    const serverStats = await getRes.json();

    // 计算今日总用时
    const totalTimeSec = speedRecords.reduce((s, r) => s + r.speedSec, 0);

    // 更新今日统计
    if (!serverStats.dailyStats) serverStats.dailyStats = {};
    serverStats.dailyStats[today] = {
      count: total,
      correct: correct,
      totalTimeSec: totalTimeSec,
    };

    // 写回服务器
    await QG._authFetch('/api/question/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverStats),
    });
  } catch (e) { /* 静默失败 */ }
};

// ============================================================
// 历史（按日期查看）
// ============================================================
QG.historyDate = null; // null = 显示日期列表, '2026-06-08' = 显示该日详情

QG.renderHistory = async function() {
  const list = document.getElementById('qgHistoryList');
  const header = document.getElementById('qgHistoryHeader');
  const records = await QG.loadRecords();

  if (records.length === 0) {
    list.innerHTML = '<div class="qg-empty-state"><div class="icon">📝</div><p>还没有练习记录</p></div>';
    if (header) header.innerHTML = '<h3 style="margin:0;">练习记录</h3>';
    return;
  }

  if (QG.historyDate === null) {
    // 日期列表视图
    QG.renderDateList(list, records, header);
  } else {
    // 某日详情视图
    QG.renderDateDetail(list, records, header);
  }
};

QG.renderDateList = function(list, records, header) {
  if (header) header.innerHTML = '<h3 style="margin:0;">练习记录</h3>';

  // 按日期分组
  const days = {};
  records.forEach(function(r) {
    const d = r.timestamp ? r.timestamp.slice(0, 10) : 'unknown';
    if (!days[d]) days[d] = { total: 0, correct: 0, speeds: [] };
    days[d].total++;
    if (r.correct) days[d].correct++;
    if (r.speedSec != null) days[d].speeds.push(r.speedSec);
  });

  // 按日期倒序排列
  const sortedDays = Object.keys(days).sort().reverse();

  // 本周几映射
  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  list.innerHTML = '<div class="qg-date-list">' +
    sortedDays.map(function(d) {
      const day = days[d];
      const acc = day.total > 0 ? Math.round(day.correct / day.total * 100) + '%' : '--';
      const avg = day.speeds.length > 0 ? Math.round(day.speeds.reduce(function(a, b) { return a + b; }, 0) / day.speeds.length) + 's' : '--';
      const dt = new Date(d + 'T00:00:00');
      const weekday = weekDays[dt.getDay()];
      const isToday = d === new Date().toISOString().slice(0, 10);
      return '<div class="qg-date-item" onclick="QG.viewDate(\'' + d + '\')">' +
        '<div class="qg-d-left">' +
          '<div>' +
            '<div class="qg-d-date">' + d + (isToday ? ' <span style="font-size:11px;color:var(--primary);">今天</span>' : '') + '</div>' +
            '<div class="qg-d-weekday">' + weekday + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="qg-d-stats">' +
          '<span>' + day.total + ' 题</span>' +
          '<span>正确率 ' + acc + '</span>' +
          '<span>平均 ' + avg + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span class="qg-d-del" onclick="event.stopPropagation();QG.deleteDate(\'' + d + '\')" title="删除该日记录">🗑️</span>' +
          '<span class="qg-d-arrow">›</span>' +
        '</div>' +
      '</div>';
    }).join('') +
    '</div>';
};

QG.viewDate = function(dateStr) {
  QG.historyDate = dateStr;
  QG.renderHistory();
};

QG.backToDateList = function() {
  QG.historyDate = null;
  QG.renderHistory();
};

QG.renderDateDetail = function(list, records, header) {
  const dayRecords = records.filter(function(r) {
    return r.timestamp && r.timestamp.slice(0, 10) === QG.historyDate;
  }).sort(function(a, b) {
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  const total = dayRecords.length;
  const correct = dayRecords.filter(function(r) { return r.correct; }).length;
  const acc = total > 0 ? Math.round(correct / total * 100) + '%' : '--';
  const speeds = dayRecords.filter(function(r) { return r.speedSec != null; }).map(function(r) { return r.speedSec; });
  const avg = speeds.length > 0 ? Math.round(speeds.reduce(function(a, b) { return a + b; }, 0) / speeds.length) + 's' : '--';

  if (header) {
    header.innerHTML =
      '<button class="btn btn-sm btn-outline qg-back-btn" onclick="QG.backToDateList()">← 返回</button>' +
      '<h3 style="margin:4px 0 2px;">' + QG.historyDate + '</h3>' +
      '<div style="font-size:13px;color:#64748b;">共 ' + total + ' 题 · 正确率 ' + acc + ' · 平均 ' + avg + '</div>' +
      QG.renderDateTypeStats(dayRecords);
  }

  if (dayRecords.length === 0) {
    list.innerHTML = '<div class="qg-empty-state"><div class="icon">📝</div><p>该日没有记录</p></div>';
    return;
  }

  const typeLabels = { mixed: '混合', decimal: '小数', fraction: '分数', matrix: '矩阵', equation: '方程组', inverse: '逆矩阵' };

  list.innerHTML = dayRecords.map(function(r) {
    const time = new Date(r.timestamp);
    const timeStr = QG._pad(time.getHours()) + ':' + QG._pad(time.getMinutes()) + ':' + QG._pad(time.getSeconds());
    const qtype = r.questionType || 'mixed';
    return '<div class="qg-history-item">' +
      '<div class="qg-history-icon">' + (r.correct ? '✅' : '❌') + '</div>' +
      '<div class="qg-history-body">' +
        '<div class="qg-h-question">' + QG.escapeHtml(r.question || r.expression || '') +
          '<span class="qg-h-type">' + (typeLabels[qtype] || qtype) + '</span>' +
        '</div>' +
        '<div class="qg-h-detail">' +
          '你的答案: <strong>' + QG.escapeHtml(r.userAnswer) + '</strong>' +
          (!r.correct ? ' · 正确答案: <strong class="qg-h-correct">' + QG.escapeHtml(r.correctAnswer) + '</strong>' : '') +
          ' · ' + timeStr +
        '</div>' +
        (r.solution ? '<div class="qg-h-solution"><span class="qg-h-sol-toggle" onclick="this.parentElement.classList.toggle(\'open\')">📖 查看过程</span><div class="qg-h-sol-content">' + QG.escapeHtml(r.solution).replace(/\n/g, '<br>') + '<br><span class="qg-h-sol-close" onclick="event.stopPropagation();this.closest(\'.qg-h-solution\').classList.remove(\'open\')">▲ 收起</span></div></div>' : '') +
      '</div>' +
      '</div>' +
    '</div>';
  }).join('');
};

QG._pad = function(n) { return n < 10 ? '0' + n : '' + n; };

QG.renderDateTypeStats = function(dayRecords) {
  const typeLabels = { mixed: '混合', decimal: '小数', fraction: '分数', matrix: '矩阵', equation: '方程组', inverse: '逆矩阵' };
  const byType = {};
  dayRecords.forEach(function(r) {
    const t = r.questionType || 'mixed';
    if (!byType[t]) byType[t] = { total: 0, correct: 0, speeds: [] };
    byType[t].total++;
    if (r.correct) byType[t].correct++;
    if (r.speedSec != null) byType[t].speeds.push(r.speedSec);
  });
  const types = Object.keys(byType);
  if (types.length <= 1) return '';
  var html = '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0;">';
  types.forEach(function(t) {
    var d = byType[t];
    var acc = d.total > 0 ? Math.round(d.correct / d.total * 100) : 0;
    var avg = d.speeds.length > 0 ? Math.round(d.speeds.reduce(function(a, b) { return a + b; }, 0) / d.speeds.length) : null;
    html += '<div style="font-size:12px;color:#64748b;display:flex;gap:10px;margin-top:3px;">' +
      '<span style="font-weight:700;color:#0f172a;min-width:50px;">' + (typeLabels[t] || t) + '</span>' +
      '<span>' + d.total + ' 题</span>' +
      '<span>正确率 ' + acc + '%</span>' +
      '<span>平均 ' + (avg !== null ? avg + 's' : '--') + '</span>' +
    '</div>';
  });
  html += '</div>';
  return html;
};

// ============================================================
// 数据管理
// ============================================================
QG.clearHistory = async function() {
  if (!confirm('确定要清空所有练习记录吗？此操作不可恢复。')) return;
  localStorage.removeItem(QG.STORAGE_KEY);
  // 如果服务器可用，也通知服务器
  if (QG.useServer) {
    try {
      await QG._authFetch('/api/question/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [] }),
      });
    } catch (e) { /* 静默失败 */ }
  }
  QG.showToast('已清空所有记录');
  QG.updateStats();
  QG.renderHistory();
};

QG.deleteDate = async function(dateStr) {
  if (!confirm('确定要删除 ' + dateStr + ' 的所有练习记录吗？此操作不可恢复。')) return;
  var records = await QG.loadRecords();
  var before = records.length;
  records = records.filter(function(r) {
    return !r.timestamp || r.timestamp.slice(0, 10) !== dateStr;
  });
  var removed = before - records.length;
  if (removed === 0) { QG.showToast('该日没有记录'); return; }
  await QG.saveRecords(records);
  QG.showToast('已删除 ' + dateStr + ' 的 ' + removed + ' 条记录');
  QG.updateStats();
  QG.renderHistory();
};

QG.exportData = async function() {
  const records = await QG.loadRecords();
  if (records.length === 0) { QG.showToast('没有数据可导出'); return; }
  const json = JSON.stringify({ records: records, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'math-records-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  QG.showToast('导出成功');
};

QG.importData = function(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const data = JSON.parse(e.target.result);
      let records = [];
      if (Array.isArray(data)) {
        records = data;
      } else if (data && data.records) {
        records = data.records;
      } else {
        throw new Error('格式错误');
      }
      if (!confirm('即将导入 ' + records.length + ' 条记录，这会覆盖当前所有数据，确定吗？')) return;
      await QG.saveRecords(records);
      QG.showToast('成功导入 ' + records.length + ' 条记录');
      QG.updateStats();
      QG.renderHistory();
    } catch (err) {
      QG.showToast('文件格式错误');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
};

// ============================================================
// UI 逻辑
// ============================================================
QG.setupTabs = function() {
  document.querySelectorAll('.qg-tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.qg-tab-btn').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.qg-tab-pane').forEach(function(p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('qgPane-' + btn.dataset.tab).classList.add('active');
      QG.refreshAll();
    });
  });
};

QG.escapeHtml = function(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

QG.setQuestionType = function(type, btn) {
  QG.questionType = type;
  document.querySelectorAll('.qg-type-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  const labels = { mixed: '混合口算', decimal: '小数计算', fraction: '分数计算', matrix: '矩阵乘法', equation: '方程组', inverse: '逆矩阵' };
  const p = document.querySelector('.qg-question-area p');
  if (p) p.textContent = '点击下方按钮，AI 将为你生成一道' + (labels[type] || '口算题');
};

QG.endPractice = function() {
  QG.currentQuestion = null;
  QG.answered = false;
  QG.showHomeScreen();
};

QG.showHomeScreen = async function() {
  const labels = { mixed: '混合口算', decimal: '小数计算', fraction: '分数计算', matrix: '矩阵乘法', equation: '方程组', inverse: '逆矩阵' };
  const area = document.getElementById('qgPracticeArea');
  area.innerHTML =
    '<div class="card question-area qg-question-area" style="padding:48px 20px;">' +
      '<div class="qg-type-selector">' +
        Object.keys(labels).map(function(k) {
          return '<button class="qg-type-btn' + (QG.questionType === k ? ' active' : '') + '" data-type="' + k + '" onclick="QG.setQuestionType(\'' + k + '\', this)">' + labels[k] + '</button>';
        }).join('') +
      '</div>' +
      '<div style="font-size:48px;margin-bottom:16px;">🧮</div>' +
      '<p style="font-size:16px;color:#64748b;margin-bottom:20px;">点击下方按钮，AI 将为你生成一道' + (labels[QG.questionType] || '口算题') + '</p>' +
      '<button class="btn btn-primary" style="font-size:16px;padding:14px 36px;" onclick="QG.generateQuestion()">生成题目</button>' +
    '</div>';
  QG.updateStats();
};

QG.refreshAll = async function() {
  QG.updateStats();
  const activePane = document.querySelector('.qg-tab-pane.active');
  if (activePane && activePane.id === 'qgPane-history') {
    await QG.renderHistory();
  }
};

// ============================================================
// 初始化
// ============================================================
QG.init = function() {
  QG.setupTabs();
  QG.showHomeScreen();
  QG.updateStats();
  QG.serverDetectionPromise = QG.detectServer();
  QG.serverDetectionPromise.then(function() {
    if (QG.useServer) {
      QG.updateStats();
      QG.renderHistory();
    }
  });
};
