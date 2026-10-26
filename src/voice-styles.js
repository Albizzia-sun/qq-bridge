import fs from 'node:fs';
import path from 'node:path';

const STYLE_IDS = ['daily', 'comfort', 'explanation'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonemptyString = value => typeof value === 'string' && value.trim().length > 0;

// This file contains trusted synthesis instructions. Chat tools select an ID;
// they cannot supply a replacement instruction or alter the voice parameters.
export function loadVoiceStyles(filePath, configDir = process.cwd()) {
  if (!nonemptyString(filePath)) throw new Error('语气配置错误：styleConfigPath 必须是非空文件路径');
  const absolutePath = path.resolve(configDir, filePath);
  let raw;
  try { raw = fs.readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, ''); }
  catch { throw new Error(`语气配置加载失败：无法读取 ${absolutePath}`); }
  let profile;
  try { profile = JSON.parse(raw); }
  catch { throw new Error('语气配置错误：文件不是有效 JSON'); }
  if (!isObject(profile) || profile.version !== 1) throw new Error('语气配置错误：version 必须为 1');
  if (!isObject(profile.styles) || Object.keys(profile.styles).length !== STYLE_IDS.length ||
      STYLE_IDS.some(id => !Object.hasOwn(profile.styles, id))) {
    throw new Error('语气配置错误：styles 必须包含且仅包含 daily、comfort、explanation');
  }
  if (!STYLE_IDS.includes(profile.defaultStyle)) throw new Error('语气配置错误：defaultStyle 必须是已配置的场景 ID');
  for (const id of STYLE_IDS) {
    if (!isObject(profile.styles[id])) throw new Error(`语气配置错误：styles.${id} 必须是对象`);
    for (const field of ['label', 'whenToUse', 'instruction']) {
      if (!nonemptyString(profile.styles[id][field])) throw new Error(`语气配置错误：styles.${id}.${field} 必须是非空字符串`);
    }
  }
  return profile;
}

export function resolveVoiceStyle(profile, id) {
  if (id === undefined) return profile?.defaultStyle;
  if (!profile) throw new Error('voiceStyle 无效：尚未启用语气配置');
  if (typeof id !== 'string' || !Object.hasOwn(profile.styles, id)) {
    throw new Error('voiceStyle 无效：请选择 daily、comfort 或 explanation');
  }
  return id;
}

export function voiceStyleGuidance(profile) {
  if (!profile) return null;
  return {
    defaultStyle: profile.defaultStyle,
    styles: Object.fromEntries(STYLE_IDS.map(id => [id, {
      label: profile.styles[id].label,
      whenToUse: profile.styles[id].whenToUse
    }])),
    instruction: '发送回复时，根据当前对话场景选择 voiceStyle；不确定时使用 defaultStyle，省略时也使用 defaultStyle。voiceStyle 只影响已决定发送的语音的语气，文字内容、是否发送语音和发送时机仍按原规则决定。'
  };
}
