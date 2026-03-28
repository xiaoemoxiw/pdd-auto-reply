/**
 * AI 意图识别引擎
 *
 * 基于 Transformers.js (ONNX Runtime) 的语义相似度匹配：
 * 1. 用户配置意图列表（每条意图含多条描述语句 + 回复话术）
 * 2. 模型加载后预计算意图描述向量
 * 3. 客户消息实时编码，与意图向量计算余弦相似度
 * 4. 超过阈值则命中该意图
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

const MODEL_SOURCES = {
  mirror: { name: 'HF 镜像（国内推荐）', host: 'https://hf-mirror.com/' },
  huggingface: { name: 'Hugging Face 官方', host: 'https://huggingface.co/' },
  local: { name: '本地导入', host: null }
};

class AIIntentEngine {
  constructor() {
    this._pipeline = null;
    this._cos_sim = null;
    this._status = 'none'; // none | downloading | ready | error
    this._intents = [];
    this._intentVectors = []; // { intentId, vector }[]
    this._downloadProgress = 0;
    this._errorMsg = '';
  }

  _getCacheDir() {
    return path.join(app.getPath('userData'), 'ai-models');
  }

  /**
   * 配置 Transformers.js 环境
   * @param {object} env - Transformers.js 的 env 对象
   * @param {'mirror'|'huggingface'|'local'} source - 下载来源
   * @param {string} [customMirror] - 自定义镜像 URL
   * @param {string} [localPath] - 本地模型文件夹路径
   */
  _configureEnv(env, source = 'mirror', customMirror, localPath) {
    env.cacheDir = this._getCacheDir();

    if (source === 'local' && localPath) {
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = localPath.endsWith('/') ? localPath : localPath + '/';
    } else {
      env.allowRemoteModels = true;
      env.allowLocalModels = true;
      if (source === 'mirror') {
        env.remoteHost = customMirror || MODEL_SOURCES.mirror.host;
      } else {
        env.remoteHost = MODEL_SOURCES.huggingface.host;
      }
    }
  }

  /**
   * 下载并加载模型
   * @param {object} opts
   * @param {'mirror'|'huggingface'|'local'} opts.source - 下载来源
   * @param {string} [opts.customMirror] - 自定义镜像 URL
   * @param {string} [opts.localPath] - 本地模型路径（source=local 时必填）
   * @param {function} [opts.onProgress] - 进度回调
   */
  async downloadModel({ source = 'mirror', customMirror, localPath, onProgress } = {}) {
    if (this._status === 'downloading') return;
    this._status = 'downloading';
    this._downloadProgress = 0;
    this._errorMsg = '';

    try {
      const { pipeline, cos_sim, env } = await import('@huggingface/transformers');

      this._configureEnv(env, source, customMirror, localPath);

      const modelPath = (source === 'local' && localPath) ? localPath : MODEL_ID;

      this._pipeline = await pipeline('feature-extraction', modelPath, {
        dtype: 'q8',
        progress_callback: (progress) => {
          if (progress.status === 'progress' && progress.progress != null) {
            this._downloadProgress = Math.round(progress.progress);
            onProgress?.({
              status: 'downloading',
              progress: this._downloadProgress,
              file: progress.file
            });
          }
          if (progress.status === 'done') {
            onProgress?.({ status: 'done', file: progress.file });
          }
        }
      });

      this._cos_sim = cos_sim;
      this._status = 'ready';
      this._downloadProgress = 100;
      onProgress?.({ status: 'ready' });

      if (this._intents.length > 0) {
        await this._computeIntentVectors();
      }
    } catch (err) {
      this._status = 'error';
      this._errorMsg = err.message;
      this._pipeline = null;
      onProgress?.({ status: 'error', error: err.message });
      throw err;
    }
  }

  /**
   * 从缓存加载已下载的模型
   */
  async loadModel() {
    if (this._pipeline) return;
    if (this._status === 'downloading') return;

    this._status = 'downloading';
    try {
      const { pipeline, cos_sim, env } = await import('@huggingface/transformers');
      env.cacheDir = this._getCacheDir();
      env.allowLocalModels = true;

      this._pipeline = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8'
      });
      this._cos_sim = cos_sim;
      this._status = 'ready';

      if (this._intents.length > 0) {
        await this._computeIntentVectors();
      }
    } catch (err) {
      this._status = 'error';
      this._errorMsg = err.message;
      this._pipeline = null;
      throw err;
    }
  }

  unloadModel() {
    this._pipeline = null;
    this._cos_sim = null;
    this._intentVectors = [];
    this._status = 'none';
  }

  /**
   * 检查本地缓存中是否已有模型文件
   */
  hasLocalCache() {
    const cacheDir = this._getCacheDir();
    const modelDir = path.join(cacheDir, 'Xenova', 'paraphrase-multilingual-MiniLM-L12-v2');
    try {
      return fs.existsSync(modelDir) &&
        fs.readdirSync(modelDir).some(f => f.endsWith('.onnx'));
    } catch {
      return false;
    }
  }

  getStatus() {
    return {
      status: this._status,
      progress: this._downloadProgress,
      modelId: MODEL_ID,
      error: this._errorMsg,
      intentCount: this._intents.filter(i => i.enabled).length,
      vectorsCached: this._intentVectors.length,
      hasCache: this.hasLocalCache()
    };
  }

  async updateIntents(intents) {
    this._intents = intents;
    if (this._pipeline) {
      await this._computeIntentVectors();
    }
  }

  async _computeIntentVectors() {
    if (!this._pipeline) return;

    const vectors = [];
    for (const intent of this._intents) {
      if (!intent.enabled || !intent.descriptions?.length) continue;

      for (const desc of intent.descriptions) {
        if (!desc.trim()) continue;
        const embedding = await this._pipeline(desc, {
          pooling: 'mean',
          normalize: true
        });
        vectors.push({
          intentId: intent.id,
          intentName: intent.name,
          description: desc,
          vector: embedding.data
        });
      }
    }
    this._intentVectors = vectors;
  }

  async match(message, threshold = 0.65) {
    if (!this._pipeline || !this._cos_sim || this._intentVectors.length === 0) {
      return { matched: false };
    }

    const msgEmbedding = await this._pipeline(message, {
      pooling: 'mean',
      normalize: true
    });

    let bestMatch = null;
    let bestSim = -1;

    for (const iv of this._intentVectors) {
      const sim = this._cos_sim(msgEmbedding.data, iv.vector);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = iv;
      }
    }

    if (!bestMatch || bestSim < threshold) {
      return { matched: false, bestSimilarity: bestSim, bestIntent: bestMatch?.intentName };
    }

    const intent = this._intents.find(i => i.id === bestMatch.intentId);
    if (!intent?.replies?.length) {
      return { matched: false, bestSimilarity: bestSim, bestIntent: bestMatch.intentName };
    }

    const reply = intent.replies[Math.floor(Math.random() * intent.replies.length)];
    return {
      matched: true,
      intentId: intent.id,
      intentName: intent.name,
      similarity: Math.round(bestSim * 1000) / 1000,
      matchedDescription: bestMatch.description,
      reply
    };
  }

  async testMatch(message, threshold = 0.65) {
    if (!this._pipeline || !this._cos_sim) {
      return { error: '模型未加载' };
    }

    if (this._intentVectors.length === 0) {
      return { error: '无可用意图向量，请先配置意图' };
    }

    const msgEmbedding = await this._pipeline(message, {
      pooling: 'mean',
      normalize: true
    });

    const results = this._intentVectors.map(iv => ({
      intentId: iv.intentId,
      intentName: iv.intentName,
      description: iv.description,
      similarity: Math.round(this._cos_sim(msgEmbedding.data, iv.vector) * 1000) / 1000
    }));

    results.sort((a, b) => b.similarity - a.similarity);

    const intentMap = new Map();
    for (const r of results) {
      if (!intentMap.has(r.intentId) || intentMap.get(r.intentId).similarity < r.similarity) {
        intentMap.set(r.intentId, r);
      }
    }
    const ranked = [...intentMap.values()].sort((a, b) => b.similarity - a.similarity);
    const top = ranked[0];

    const intent = top ? this._intents.find(i => i.id === top.intentId) : null;
    const reply = (intent?.replies?.length && top.similarity >= threshold)
      ? intent.replies[Math.floor(Math.random() * intent.replies.length)]
      : null;

    return {
      matched: top ? top.similarity >= threshold : false,
      threshold,
      ranking: ranked.slice(0, 8),
      bestMatch: top ? {
        intentId: top.intentId,
        intentName: top.intentName,
        similarity: top.similarity,
        reply
      } : null
    };
  }

  isReady() {
    return this._status === 'ready' && this._pipeline != null;
  }
}

module.exports = { AIIntentEngine, MODEL_ID, MODEL_SOURCES };
