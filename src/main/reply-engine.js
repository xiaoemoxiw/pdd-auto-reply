/**
 * 自动回复规则引擎（关键词组 + 评分匹配 + 场景兜底）
 *
 * 规则格式:
 * {
 *   id: string,
 *   name: string,
 *   enabled: boolean,
 *   keywords: string[],                  // 旧版扁平关键词（向后兼容）
 *   keywordGroups: string[][] | undefined,// 关键词分组（优先使用）
 *   excludeKeywords: string[] | undefined,// 否定关键词，命中则跳过
 *   matchType: 'contains' | 'exact' | 'regex',
 *   reply: string,
 *   shops: string[] | null,
 *   priority: number,
 *   minScore: number | undefined          // 最低匹配分（默认 5）
 * }
 *
 * 兜底回复配置（defaultReply）:
 * {
 *   enabled: boolean,
 *   texts: string[],                     // 多条兜底话术
 *   text: string | undefined,            // 旧版单条（向后兼容）
 *   delay: number,                       // 毫秒
 *   cooldown: number,                    // 同一客户冷却时间（毫秒）
 *   strategy: 'random' | 'sequential',
 *   cancelOnHumanReply: boolean,
 *   scenes: Scene[]                      // 场景分类兜底
 * }
 */

const SCORE = {
  GROUP_HIT: 10,
  EXACT_BONUS: 20,
  LEGACY_HIT: 10,
  MIN_DEFAULT: 5
};

class ReplyEngine {
  constructor(rules = []) {
    this.rules = this._sortRules(rules);
    this._seqCounter = 0;
  }

  updateRules(rules) {
    this.rules = this._sortRules(rules);
  }

  _sortRules(rules) {
    return [...rules]
      .filter(r => r.enabled)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  match(message, shopId = null) {
    if (!message || !message.trim()) return null;
    const msg = message.trim();

    let bestRule = null;
    let bestScore = -1;

    for (const rule of this.rules) {
      if (shopId && rule.shops && rule.shops.length > 0) {
        if (!rule.shops.includes(shopId)) continue;
      }

      const score = this._scoreRule(msg, rule);
      if (score < 0) continue;

      const minScore = rule.minScore ?? SCORE.MIN_DEFAULT;
      if (score < minScore) continue;

      const finalScore = score + (rule.priority || 0) * 0.1;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestRule = rule;
      }
    }

    return bestRule ? this._buildReply(bestRule.reply, { message: msg }) : null;
  }

  _scoreRule(message, rule) {
    const lowerMsg = message.toLowerCase();

    if (this._hitExclude(lowerMsg, rule.excludeKeywords)) return -1;

    if (rule.keywordGroups?.length) {
      return this._scoreByGroups(lowerMsg, message, rule);
    }

    return this._scoreLegacy(lowerMsg, message, rule);
  }

  _hitExclude(lowerMsg, excludeKeywords) {
    if (!excludeKeywords?.length) return false;
    return excludeKeywords.some(kw => lowerMsg.includes(kw.toLowerCase()));
  }

  _scoreByGroups(lowerMsg, rawMsg, rule) {
    let groupHits = 0;

    for (const group of rule.keywordGroups) {
      if (!group?.length) continue;
      const hit = group.some(kw => {
        switch (rule.matchType) {
          case 'exact':
            return lowerMsg === kw.toLowerCase();
          case 'regex':
            try { return new RegExp(kw, 'i').test(rawMsg); } catch { return false; }
          default:
            return lowerMsg.includes(kw.toLowerCase());
        }
      });
      if (hit) groupHits++;
    }

    if (groupHits === 0) return 0;

    let score = groupHits * SCORE.GROUP_HIT;
    if (rule.matchType === 'exact') score += SCORE.EXACT_BONUS;

    return score;
  }

  _scoreLegacy(lowerMsg, rawMsg, rule) {
    if (!rule.keywords?.length) return 0;

    const hit = this._matchLegacy(lowerMsg, rawMsg, rule);
    return hit ? SCORE.LEGACY_HIT : 0;
  }

  _matchLegacy(lowerMsg, rawMsg, rule) {
    switch (rule.matchType) {
      case 'exact':
        return rule.keywords.some(kw => lowerMsg === kw.toLowerCase());
      case 'regex':
        return rule.keywords.some(kw => {
          try { return new RegExp(kw, 'i').test(rawMsg); } catch { return false; }
        });
      case 'contains':
      default:
        return rule.keywords.some(kw => lowerMsg.includes(kw.toLowerCase()));
    }
  }

  testMatch(message) {
    if (!message || !message.trim()) return { matched: false };
    const msg = message.trim();

    let bestRule = null;
    let bestScore = -1;

    for (const rule of this.rules) {
      const score = this._scoreRule(msg, rule);
      if (score < 0) continue;

      const minScore = rule.minScore ?? SCORE.MIN_DEFAULT;
      if (score < minScore) continue;

      const finalScore = score + (rule.priority || 0) * 0.1;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestRule = rule;
      }
    }

    if (!bestRule) return { matched: false };

    return {
      matched: true,
      ruleName: bestRule.name,
      ruleId: bestRule.id,
      score: Math.round(bestScore * 10) / 10,
      reply: this._buildReply(bestRule.reply, { message: msg })
    };
  }

  /**
   * 带兜底的匹配：支持场景分类 + 多话术轮换
   * 返回 { reply, matched, ruleName, score, sceneId? }
   */
  matchWithFallback(message, { shopId = null, defaultReply = null } = {}) {
    if (!message || !message.trim()) return { reply: null, matched: false };
    const msg = message.trim();

    let bestRule = null;
    let bestScore = -1;

    for (const rule of this.rules) {
      if (shopId && rule.shops && rule.shops.length > 0) {
        if (!rule.shops.includes(shopId)) continue;
      }

      const score = this._scoreRule(msg, rule);
      if (score < 0) continue;

      const minScore = rule.minScore ?? SCORE.MIN_DEFAULT;
      if (score < minScore) continue;

      const finalScore = score + (rule.priority || 0) * 0.1;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestRule = rule;
      }
    }

    if (bestRule) {
      return {
        reply: this._buildReply(bestRule.reply, { message: msg }),
        matched: true,
        ruleName: bestRule.name,
        ruleId: bestRule.id,
        score: Math.round(bestScore * 10) / 10
      };
    }

    if (!defaultReply?.enabled) return { reply: null, matched: false };

    // 场景分类兜底：按触发词匹配最合适的场景
    const sceneResult = this._matchScene(msg, defaultReply.scenes);
    if (sceneResult) {
      return {
        reply: this._buildReply(sceneResult.reply, { message: msg }),
        matched: false,
        ruleName: `兜底·${sceneResult.sceneName}`,
        sceneId: sceneResult.sceneId,
        score: 0
      };
    }

    // 通用兜底：多话术轮换（向后兼容旧版 text 字段）
    const texts = defaultReply.texts?.length
      ? defaultReply.texts
      : (defaultReply.text ? [defaultReply.text] : []);
    if (texts.length === 0) return { reply: null, matched: false };

    const text = this._pickText(texts, defaultReply.strategy || 'random');
    return {
      reply: this._buildReply(text, { message: msg }),
      matched: false,
      ruleName: '兜底回复',
      score: 0
    };
  }

  /**
   * 场景匹配：按优先级遍历场景，检查触发词命中
   */
  _matchScene(message, scenes) {
    if (!scenes?.length) return null;
    const lowerMsg = message.toLowerCase();

    const sorted = [...scenes]
      .filter(s => s.enabled !== false && s.signals?.length && s.replies?.length)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const scene of sorted) {
      if (scene.signals.some(s => lowerMsg.includes(s.toLowerCase()))) {
        return {
          sceneId: scene.id,
          sceneName: scene.name,
          reply: this._pickText(scene.replies, 'random')
        };
      }
    }
    return null;
  }

  /**
   * 从话术列表中选取一条（随机 or 顺序轮换）
   */
  _pickText(texts, strategy) {
    if (!texts.length) return '';
    if (texts.length === 1) return texts[0];

    if (strategy === 'sequential') {
      const text = texts[this._seqCounter % texts.length];
      this._seqCounter++;
      return text;
    }

    return texts[Math.floor(Math.random() * texts.length)];
  }

  _buildReply(template, context) {
    return template
      .replace(/\{time\}/g, new Date().toLocaleTimeString('zh-CN'))
      .replace(/\{date\}/g, new Date().toLocaleDateString('zh-CN'));
  }
}

module.exports = { ReplyEngine };
