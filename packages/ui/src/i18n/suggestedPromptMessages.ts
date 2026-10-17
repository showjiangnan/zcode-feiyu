// Modified by ZCode Feiyu.
export const suggestedPromptMessagesZh = {
  "suggestedPrompt.title": "SuggestedPrompt",
  "suggestedPrompt.description":
    "实验性提示预测：根据会话内容预测你下一轮可能写的提示词，作为可自由编辑的输入建议。",
  "suggestedPrompt.enabled": "启用提示预测能力",
  "suggestedPrompt.globalDescription":
    "总开关只开放能力。每个会话默认关闭，需要在输入框模式选择右侧单独确认开启。",
  "suggestedPrompt.model": "预测模型与思考强度",
  "suggestedPrompt.modelDescription":
    "独立选择供应商、模型及思考强度。工作区记忆开启时附加相关记忆；预测不会执行工具或自动发送。",
  "suggestedPrompt.selectModel": "请选择预测使用的模型",
  "suggestedPrompt.modelUnavailable": "预测暂不可用：请检查独立模型、思考强度及当前 Host 支持。",
  "suggestedPrompt.enableSession": "为此会话开启提示预测（实验性）",
  "suggestedPrompt.disableSession": "关闭此会话的提示预测",
  "suggestedPrompt.confirmTitle": "开启提示预测 · 实验性功能",
  "suggestedPrompt.confirmDescription":
    "SuggestedPrompt 会根据当前会话预测你下一轮可能写的提示词，仅作为辅助建议。\n\n生成速度取决于会话上下文的轮次、长度，以及所选模型的输出速度。首次开启不会马上显示建议；后续一轮正常完成、会话空闲后，才会在后台尝试生成。\n\n这是后台辅助服务，不会干扰正常工作流程。建议以淡色显示，聚焦输入框后按 Tab 可填入，也可直接忽略；你随时可以自由编辑，建议不会自动发送。\n\n本次确认只为当前会话开启。",
  "suggestedPrompt.confirmEnable": "为此会话开启",
  "suggestedPrompt.generating": "正在后台预测下一轮提示词，你可以继续正常输入",
  "suggestedPrompt.failed": "本轮未生成可用建议；下次正常对话完成后再尝试",
  "suggestedPrompt.accept": "采用提示建议",
  "suggestedPrompt.tabHint": "Tab · 采用建议",
};

export const suggestedPromptMessagesEn = {
  "suggestedPrompt.title": "SuggestedPrompt",
  "suggestedPrompt.description":
    "Experimental prompt prediction: use the conversation to suggest what you might type next, ready for you to edit.",
  "suggestedPrompt.enabled": "Enable prompt prediction capability",
  "suggestedPrompt.globalDescription":
    "This only enables the capability. Each conversation starts off and requires separate confirmation beside the input mode selector.",
  "suggestedPrompt.model": "Prediction model and reasoning",
  "suggestedPrompt.modelDescription":
    "Choose a separate provider, model, and reasoning level. Relevant workspace memory is included when enabled. Predictions never run tools or send messages.",
  "suggestedPrompt.selectModel": "Choose a prediction model",
  "suggestedPrompt.modelUnavailable":
    "Prediction is unavailable. Check the selected model, reasoning level, and Host support.",
  "suggestedPrompt.enableSession": "Enable prompt prediction for this conversation (experimental)",
  "suggestedPrompt.disableSession": "Disable prompt prediction for this conversation",
  "suggestedPrompt.confirmTitle": "Enable prompt prediction · Experimental",
  "suggestedPrompt.confirmDescription":
    "SuggestedPrompt predicts what you might type next based on this conversation. Its suggestions are optional assistance.\n\nGeneration speed depends on the number and length of conversation turns and the selected model’s output speed. Enabling it will not show a suggestion immediately. Prediction runs in the background after a subsequent successful turn, once the conversation is idle.\n\nThis background service does not interrupt your normal workflow. Suggestions appear as faint text. Focus the input and press Tab to adopt one, or simply ignore it. You can freely edit at any time, and suggestions are never sent automatically.\n\nThis confirmation enables prediction only for this conversation.",
  "suggestedPrompt.confirmEnable": "Enable for this conversation",
  "suggestedPrompt.generating": "Predicting in the background. You can continue typing.",
  "suggestedPrompt.failed":
    "No usable suggestion this turn. Prediction can run after the next successful conversation turn.",
  "suggestedPrompt.accept": "Use suggested prompt",
  "suggestedPrompt.tabHint": "Tab · Use suggestion",
};
