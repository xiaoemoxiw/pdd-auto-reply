const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { MODEL_SOURCES } = require('../reply/ai-intent');

function registerAiIpc({
  ipcMain,
  app,
  dialog,
  store,
  DEFAULT_AI_INTENTS,
  AIIntentEngine,
  getMainWindow,
  getAiIntentEngine,
  setAiIntentEngine
}) {
  function ensureAiIntentEngine() {
    let engine = getAiIntentEngine();
    if (!engine) {
      engine = new AIIntentEngine();
      setAiIntentEngine(engine);
    }
    return engine;
  }

  ipcMain.handle('ai-get-system-info', () => {
    const totalMemGB = os.totalmem() / (1024 ** 3);
    const freeMemGB = os.freemem() / (1024 ** 3);
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model || '未知';
    const cpuCores = cpus.length;
    const platform = os.platform();
    const arch = os.arch();

    let diskFreeGB = null;
    try {
      const cacheDir = path.join(app.getPath('userData'), 'ai-models');
      if (platform === 'win32') {
        const drive = cacheDir.charAt(0).toUpperCase();
        const out = execSync(`wmic logicaldisk where "DeviceID='${drive}:'" get FreeSpace /format:value`, { encoding: 'utf-8' });
        const match = out.match(/FreeSpace=(\d+)/);
        if (match) {
          diskFreeGB = parseInt(match[1], 10) / (1024 ** 3);
        }
      } else {
        const out = execSync(`df -k "${app.getPath('userData')}"`, { encoding: 'utf-8' });
        const lines = out.trim().split('\n');
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          diskFreeGB = parseInt(parts[3], 10) / (1024 ** 2);
        }
      }
    } catch {}

    let recommendation = 'good';
    const issues = [];

    if (totalMemGB < 4) {
      recommendation = 'poor';
      issues.push(`内存仅 ${totalMemGB.toFixed(1)} GB，低于最低要求 4 GB`);
    } else if (totalMemGB < 8) {
      if (recommendation !== 'poor') recommendation = 'fair';
      issues.push(`内存 ${totalMemGB.toFixed(1)} GB，可运行但可能偶尔卡顿`);
    }

    if (freeMemGB < 1) {
      recommendation = 'poor';
      issues.push(`当前可用内存仅 ${freeMemGB.toFixed(1)} GB，建议关闭部分程序后再使用`);
    }

    if (cpuCores < 2) {
      if (recommendation !== 'poor') recommendation = 'fair';
      issues.push(`CPU 仅 ${cpuCores} 核，推理速度可能较慢`);
    }

    if (diskFreeGB !== null && diskFreeGB < 0.5) {
      recommendation = 'poor';
      issues.push(`磁盘剩余空间仅 ${diskFreeGB.toFixed(1)} GB，不足以存放模型文件`);
    }

    if (issues.length === 0) {
      issues.push('您的电脑配置满足 AI 模型运行要求');
    }

    return {
      cpu: { model: cpuModel, cores: cpuCores },
      memory: {
        total: Math.round(totalMemGB * 10) / 10,
        free: Math.round(freeMemGB * 10) / 10
      },
      disk: diskFreeGB !== null ? { free: Math.round(diskFreeGB * 10) / 10 } : null,
      platform,
      arch,
      recommendation,
      issues
    };
  });

  ipcMain.handle('ai-get-config', () => {
    const config = store.get('aiIntent');
    if (!config.intents) config.intents = DEFAULT_AI_INTENTS;
    return config;
  });

  ipcMain.handle('ai-save-config', (event, config) => {
    store.set('aiIntent', config);
    const engine = getAiIntentEngine();
    if (engine) {
      engine.updateIntents(config.intents.filter(item => item.enabled));
    }
    return true;
  });

  ipcMain.handle('ai-reset-intents', () => {
    store.set('aiIntent.intents', DEFAULT_AI_INTENTS);
    const engine = getAiIntentEngine();
    if (engine) {
      engine.updateIntents(DEFAULT_AI_INTENTS.filter(item => item.enabled));
    }
    return DEFAULT_AI_INTENTS;
  });

  ipcMain.handle('ai-get-status', () => {
    const engine = ensureAiIntentEngine();
    return engine.getStatus();
  });

  ipcMain.handle('ai-get-sources', () => MODEL_SOURCES);

  ipcMain.handle('ai-download-model', async (event, { source, customMirror, localPath } = {}) => {
    const engine = ensureAiIntentEngine();
    const modelSource = source || store.get('aiIntent.modelSource') || 'mirror';
    const mirror = customMirror || store.get('aiIntent.customMirror') || '';

    store.set('aiIntent.modelSource', modelSource);
    if (mirror) store.set('aiIntent.customMirror', mirror);

    try {
      await engine.downloadModel({
        source: modelSource,
        customMirror: mirror,
        localPath,
        onProgress(progress) {
          getMainWindow()?.webContents.send('ai-download-progress', progress);
        }
      });

      store.set('aiIntent.modelStatus', 'ready');
      const intents = store.get('aiIntent.intents') || DEFAULT_AI_INTENTS;
      await engine.updateIntents(intents.filter(item => item.enabled));
      return { success: true };
    } catch (error) {
      store.set('aiIntent.modelStatus', 'none');
      return { error: error.message };
    }
  });

  ipcMain.handle('ai-select-local-model', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择本地模型文件夹',
      message: '请选择包含 ONNX 模型文件的文件夹（需包含 config.json 和 .onnx 文件）',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle('ai-load-model', async () => {
    const engine = ensureAiIntentEngine();
    try {
      await engine.loadModel();
      store.set('aiIntent.modelStatus', 'ready');
      const intents = store.get('aiIntent.intents') || DEFAULT_AI_INTENTS;
      await engine.updateIntents(intents.filter(item => item.enabled));
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('ai-unload-model', () => {
    const engine = getAiIntentEngine();
    if (engine) engine.unloadModel();
    store.set('aiIntent.modelStatus', 'none');
    store.set('aiIntent.enabled', false);
    return true;
  });

  ipcMain.handle('ai-test-match', async (event, message) => {
    const engine = getAiIntentEngine();
    if (!engine?.isReady()) return { error: '模型未加载' };
    const threshold = store.get('aiIntent.threshold') || 0.65;
    return engine.testMatch(message, threshold);
  });

  ipcMain.handle('ai-set-enabled', (event, enabled) => {
    store.set('aiIntent.enabled', enabled);
    return true;
  });
}

function autoLoadAiIntentEngine({
  store,
  DEFAULT_AI_INTENTS,
  AIIntentEngine,
  getAiIntentEngine,
  setAiIntentEngine
}) {
  const aiConfig = store.get('aiIntent');
  if (aiConfig.modelStatus !== 'ready' && !aiConfig.enabled) return;

  let engine = getAiIntentEngine();
  if (!engine) {
    engine = new AIIntentEngine();
    setAiIntentEngine(engine);
  }

  engine.loadModel().then(() => {
    const intents = store.get('aiIntent.intents') || DEFAULT_AI_INTENTS;
    engine.updateIntents(intents.filter(item => item.enabled));
    console.log('[PDD助手] AI 意图引擎已自动加载');
  }).catch(error => {
    console.error('[PDD助手] AI 意图引擎自动加载失败:', error.message);
  });
}

module.exports = {
  registerAiIpc,
  autoLoadAiIntentEngine
};
