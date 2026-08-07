/**
 * agentQuestionnaire — Plan 模式静态问卷解析与校验。
 *
 * 职责：
 * - 从 ACP elicitation 的 Python eval 消息中严格识别并解析
 *   问卷定义（parseQuestionnaireEval），不执行任意 Python 代码。
 * - 校验用户提交的答案是否满足问卷约束（validateQuestionnaireAnswers）。
 * - 将有效答案格式化为续发文本（formatQuestionnaireFollowUp）。
 *
 * 安全约束：仅允许 JSON 风格字面量 + True/False/None 常量，
 * 且列表外部必须严格匹配 `import json` + `print(json.dumps(questions))`
 * 模式，拒绝任意 eval。
 */
import type { QuestionnaireAnswer, QuestionnaireDefinition, QuestionnaireOption, QuestionnaireQuestion } from './agentTypes.js';
import { isRecord } from './agentUtils.js';

// 仅识别 Plan 模式约定的静态 Python 问卷；不执行、不推断任意 Python 代码。
export const parseQuestionnaireEval = (message: string): QuestionnaireDefinition | null => {
  const header = /^Allow tool:\s*eval\s*\r?\nLanguage:\s*python\s*\r?\nCode:\s*\r?\n([\s\S]+)$/.exec(message);
  if (!header) return null;
  const code = header[1];
  const assignment = /^[ \t]*questions[ \t]*=[ \t]*/.exec(code);
  if (!assignment || code[assignment[0].length] !== '[') return null;

  const start = assignment[0].length;
  let depth = 0;
  let quote = '';
  let escaped = false;
  let end = -1;
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
      if (depth < 0) return null;
    }
  }
  if (end < 0 || quote) return null;

  // 列表之外只允许 json 导入和 questions 序列化打印，避免任意 eval 被伪装为问卷。
  const tail = code.slice(end);
  if (!/^\s*import\s+json\s*\r?\n\s*print\s*\(\s*json\.dumps\s*\(\s*questions(?:\s*,\s*(?:ensure_ascii\s*=\s*(?:True|False)|indent\s*=\s*\d+))*\s*\)\s*\)\s*$/.test(tail)) {
    return null;
  }

  // 示例为 JSON 风格字面量，只额外兼容 Python 的 True/False/None 常量。
  const literal = code.slice(start, end);
  let normalized = '';
  quote = '';
  escaped = false;
  for (let index = 0; index < literal.length; index += 1) {
    const char = literal[index];
    if (quote) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      normalized += char;
      continue;
    }
    const word = /^(True|False|None)\b/.exec(literal.slice(index));
    if (word) {
      normalized += word[1] === 'True' ? 'true' : word[1] === 'False' ? 'false' : 'null';
      index += word[1].length - 1;
    } else {
      normalized += char;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const questions: QuestionnaireQuestion[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.question !== 'string' || !item.question.trim() ||
      typeof item.multiSelect !== 'boolean' || !Array.isArray(item.options) || item.options.length === 0) {
      return null;
    }
    const options: QuestionnaireOption[] = [];
    for (const option of item.options) {
      if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim() ||
        (option.description !== undefined && typeof option.description !== 'string')) {
        return null;
      }
      options.push({
        label: option.label,
        ...(typeof option.description === 'string' ? { description: option.description } : {})
      });
    }
    questions.push({
      question: item.question,
      ...(typeof item.header === 'string' && item.header.trim() ? { header: item.header } : {}),
      options,
      multiSelect: item.multiSelect
    });
  }
  return { questions };
};

export const validateQuestionnaireAnswers = (
  questionnaire: QuestionnaireDefinition,
  answers: QuestionnaireAnswer[] | undefined
): QuestionnaireAnswer[] | null => {
  if (!Array.isArray(answers) || answers.length !== questionnaire.questions.length) return null;
  const normalized: QuestionnaireAnswer[] = [];
  for (let index = 0; index < questionnaire.questions.length; index += 1) {
    const answer = answers.find((item) => item?.questionIndex === index);
    const question = questionnaire.questions[index];
    if (!answer || !Array.isArray(answer.selections) || answer.selections.length === 0 ||
      (!question.multiSelect && answer.selections.length !== 1)) {
      return null;
    }
    const allowed = new Set(question.options.map((option) => option.label));
    const selections = [...new Set(answer.selections)];
    if (selections.length !== answer.selections.length || selections.some((value) => typeof value !== 'string' || !allowed.has(value))) {
      return null;
    }
    normalized.push({ questionIndex: index, selections });
  }
  return normalized;
};

export const formatQuestionnaireFollowUp = (
  questionnaire: QuestionnaireDefinition,
  answers: QuestionnaireAnswer[]
) => [
  '用户已提交问卷答案，请据此继续当前 Plan 工作：',
  ...answers.map((answer) => {
    const question = questionnaire.questions[answer.questionIndex];
    return `- ${question.header ? `[${question.header}] ` : ''}${question.question}：${answer.selections.join('、')}`;
  })
].join('\n');
