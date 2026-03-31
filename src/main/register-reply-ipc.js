function registerReplyIpc({
  ipcMain,
  store,
  DEFAULT_SCENES,
  SYSTEM_PHRASES,
  PHRASE_CATEGORIES,
  ReplyEngine,
  getReplyEngine,
  setReplyEngine,
  getAiIntentEngine,
  getShopManager
}) {
  function ensureReplyEngine() {
    let engine = getReplyEngine();
    if (!engine) {
      engine = new ReplyEngine(store.get('rules'));
      setReplyEngine(engine);
    }
    return engine;
  }

  ipcMain.handle('get-rules', () => store.get('rules'));

  ipcMain.handle('save-rules', (event, rules) => {
    store.set('rules', rules);
    const engine = getReplyEngine();
    if (engine) engine.updateRules(rules);
    return true;
  });

  ipcMain.handle('get-auto-reply-enabled', () => store.get('autoReplyEnabled'));

  ipcMain.handle('set-auto-reply-enabled', (event, enabled) => {
    store.set('autoReplyEnabled', enabled);
    const shopManager = getShopManager();
    if (shopManager) {
      for (const view of shopManager.views.values()) {
        view.webContents.send('auto-reply-toggle', enabled);
      }
    }
    return true;
  });

  ipcMain.handle('get-default-reply', () => {
    const config = store.get('defaultReply');
    if (config && !config.texts && config.text) {
      config.texts = [config.text];
    }
    if (config && !config.scenes) {
      config.scenes = DEFAULT_SCENES;
    }
    return config;
  });

  ipcMain.handle('save-default-reply', (event, config) => {
    store.set('defaultReply', config);
    return true;
  });

  ipcMain.handle('get-system-phrases', () => SYSTEM_PHRASES);
  ipcMain.handle('get-phrase-categories', () => PHRASE_CATEGORIES);
  ipcMain.handle('get-phrase-library', () => store.get('phraseLibrary') || []);

  ipcMain.handle('save-phrase-library', (event, phrases) => {
    store.set('phraseLibrary', phrases);
    return true;
  });

  ipcMain.handle('add-phrase-to-fallback', (event, text) => {
    const config = store.get('defaultReply');
    if (!config.texts) config.texts = [];
    if (!config.texts.includes(text)) {
      config.texts.push(text);
      store.set('defaultReply', config);
    }
    return true;
  });

  ipcMain.handle('add-phrase-to-scene', (event, { sceneId, text }) => {
    const config = store.get('defaultReply');
    const scene = config.scenes?.find(item => item.id === sceneId);
    if (scene) {
      if (!scene.replies.includes(text)) {
        scene.replies.push(text);
        store.set('defaultReply', config);
      }
    }
    return true;
  });

  ipcMain.handle('get-unmatched-log', () => store.get('unmatchedLog') || []);

  ipcMain.handle('clear-unmatched-log', () => {
    store.set('unmatchedLog', []);
    return true;
  });

  ipcMain.handle('test-rule', (event, message) => {
    return ensureReplyEngine().testMatch(message);
  });

  ipcMain.handle('simulate-message-flow', async (event, { message }) => {
    const replyEngine = ensureReplyEngine();
    const steps = [];
    const startedAt = Date.now();

    const keywordStartedAt = Date.now();
    const keywordResult = replyEngine.testMatch(message);
    steps.push({
      name: '关键词匹配',
      duration: Date.now() - keywordStartedAt,
      matched: keywordResult.matched,
      detail: keywordResult.matched
        ? { ruleName: keywordResult.ruleName, score: keywordResult.score, reply: keywordResult.reply }
        : null
    });

    if (keywordResult.matched) {
      return {
        steps,
        finalReply: keywordResult.reply,
        finalSource: '关键词匹配',
        finalSourceRule: keywordResult.ruleName,
        totalDuration: Date.now() - startedAt
      };
    }

    const aiConfig = store.get('aiIntent');
    const aiIntentEngine = getAiIntentEngine();
    const aiEnabled = aiConfig.enabled && aiIntentEngine?.isReady();
    const aiStartedAt = Date.now();

    if (aiEnabled) {
      try {
        const threshold = aiConfig.threshold || 0.65;
        const aiResult = await aiIntentEngine.testMatch(message, threshold);
        steps.push({
          name: 'AI 意图识别',
          duration: Date.now() - aiStartedAt,
          matched: aiResult.matched,
          detail: aiResult.matched && aiResult.bestMatch
            ? {
                intentName: aiResult.bestMatch.intentName,
                similarity: aiResult.bestMatch.similarity,
                reply: aiResult.bestMatch.reply,
                ranking: aiResult.ranking
              }
            : { ranking: aiResult.ranking, threshold }
        });

        if (aiResult.matched && aiResult.bestMatch?.reply) {
          return {
            steps,
            finalReply: aiResult.bestMatch.reply,
            finalSource: 'AI 意图识别',
            finalSourceRule: `AI·${aiResult.bestMatch.intentName}`,
            totalDuration: Date.now() - startedAt
          };
        }
      } catch (error) {
        steps.push({
          name: 'AI 意图识别',
          duration: Date.now() - aiStartedAt,
          matched: false,
          detail: { error: error.message }
        });
      }
    } else {
      steps.push({
        name: 'AI 意图识别',
        duration: 0,
        matched: false,
        skipped: true,
        detail: { reason: !aiConfig.enabled ? '未启用' : '模型未加载' }
      });
    }

    const fallbackStartedAt = Date.now();
    const defaultReply = store.get('defaultReply');
    const fallbackResult = replyEngine.matchWithFallback(message, { defaultReply });
    const fallbackMatched = !fallbackResult.matched && !!fallbackResult.reply;
    steps.push({
      name: '兜底回复',
      duration: Date.now() - fallbackStartedAt,
      matched: fallbackMatched,
      detail: fallbackMatched
        ? { ruleName: fallbackResult.ruleName, reply: fallbackResult.reply, sceneId: fallbackResult.sceneId }
        : { reason: defaultReply?.enabled ? '无可用兜底话术' : '兜底回复未启用' }
    });

    return {
      steps,
      finalReply: fallbackResult.reply || null,
      finalSource: fallbackMatched ? '兜底回复' : '无匹配',
      finalSourceRule: fallbackResult.ruleName || null,
      totalDuration: Date.now() - startedAt
    };
  });

  ipcMain.handle('get-quick-phrases', () => store.get('quickPhrases'));

  ipcMain.handle('save-quick-phrases', (event, phrases) => {
    store.set('quickPhrases', phrases);
    return true;
  });

  ipcMain.handle('send-quick-phrase', (event, text) => {
    const view = getShopManager()?.getActiveView();
    if (view) view.webContents.send('send-reply', { message: text });
    return true;
  });
}

module.exports = {
  registerReplyIpc
};
