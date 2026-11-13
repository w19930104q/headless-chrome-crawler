const isString = require('lodash/isString');
const isArray = require('lodash/isArray');
const includes = require('lodash/includes');
const uniq = require('lodash/uniq');

const GENERAL_BOT = '*';
const META_ROBOTS = 'robots';
const ALL_DIRECTIVE = 'all';
const NONE_DIRECTIVE = 'none';
const NOINDEX_DIRECTIVE = 'noindex';
const NOFOLLOW_DIRECTIVE = 'nofollow';

/**
 * Parses and merges page-level indexing directives delivered through the
 * final response's `X-Robots-Tag` HTTP header and the main document's
 * `<meta name="robots">` (or bot-specific `<meta>`) tags.
 *
 * Only the final response and the main document are taken into account.
 * Intermediate redirect responses and iframe documents never participate.
 */
class RobotsMeta {
  /**
   * Normalizes the explicitly specified bot names into a lower-cased,
   * de-duplicated list. The general rules (`*` / `robots`) always apply and
   * are not required to be listed here.
   *
   * @param {?(string|Array<!string>)} userAgents
   * @return {!Array<!string>}
   */
  static normalizeUserAgents(userAgents) {
    if (!userAgents) return [];
    let list;
    if (isString(userAgents)) list = [userAgents];
    else if (isArray(userAgents)) list = userAgents;
    else list = [];
    return uniq(list
      .filter(userAgent => isString(userAgent) && userAgent.trim())
      .map(userAgent => userAgent.trim().toLowerCase()));
  }

  /**
   * Evaluates the merged policy for the given bots.
   *
   * @param {!Object} params
   * @param {!Object} params.headers Final response headers, lower-cased or
   *   mixed-case keys are both supported.
   * @param {!Array<!{name: !string, content: ?string}>} params.metas Main
   *   document meta tags.
   * @param {?(string|Array<!string>)} params.userAgents Explicitly specified
   *   bot names whose rules must be merged with the general rules.
   * @return {!Object} The merged policy decision.
   */
  static evaluate({ headers, metas, userAgents }) {
    const bots = RobotsMeta.normalizeUserAgents(userAgents);
    const entries = RobotsMeta._headerEntries(headers, bots)
      .concat(RobotsMeta._metaEntries(metas, bots));
    const policies = {};
    [GENERAL_BOT].concat(bots).forEach(bot => {
      policies[bot] = RobotsMeta._policyFor(bot, entries);
    });
    const merged = RobotsMeta._mergePolicies(policies);
    return {
      obeyed: true,
      noindex: merged.noindex,
      nofollow: merged.nofollow,
      bots,
      policies,
    };
  }

  /**
   * Collects the meta tags of the main document. Iframes are not queried, so
   * their own policies never participate in the merge.
   *
   * @return {!Array<!{name: !string, content: ?string}>}
   */
  static collectMetas() {
    return Array.prototype.map.call(
      window.document.querySelectorAll('meta[name]'),
      meta => ({ name: meta.getAttribute('name') || '', content: meta.getAttribute('content') || '' }), // eslint-disable-line comma-dangle
    );
  }

  /**
   * @param {!Object} headers
   * @param {!Array<!string>} bots
   * @return {!Array<!{bot: ?string, directives: !Array<!string>}>}
   * @private
   */
  static _headerEntries(headers, bots) {
    if (!headers) return [];
    const value = RobotsMeta._getHeader(headers, 'x-robots-tag');
    if (!value) return [];
    const entries = [];
    String(value).split(/\r?\n/).forEach(field => {
      if (!field.trim()) return;
      RobotsMeta._parseHeaderField(field, bots).forEach(entry => entries.push(entry));
    });
    return entries;
  }

  /**
   * Reads a response header case-insensitively. Node joins repeated headers
   * with new lines, which are handled by the caller.
   *
   * @param {!Object} headers
   * @param {!string} name
   * @return {?string}
   * @private
   */
  static _getHeader(headers, name) {
    const key = Object.keys(headers).find(_name => _name.toLowerCase() === name);
    return key === undefined ? null : headers[key];
  }

  /**
   * Tokenizes one header field. Each comma-separated token is either a bare
   * directive or a `bot:` prefix opening a new bot group, so a single field
   * may mix general directives and several explicit bot rules
   * (`noindex, googlebot: nofollow, bingbot: none`).
   *
   * @param {!string} field
   * @param {!Array<!string>} bots
   * @return {!Array<!{bot: ?string, directives: !Array<!string>}>}
   * @private
   */
  static _parseHeaderField(field, bots) {
    const entries = [];
    let currentBot = null;
    let currentDirectives = [];
    const flush = () => {
      if (currentDirectives.length) {
        entries.push({ bot: currentBot, directives: currentDirectives });
      }
      currentDirectives = [];
    };
    field.split(',').forEach(token => {
      const trimmed = token.trim();
      if (!trimmed) return;
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex !== -1) {
        const prefix = trimmed.slice(0, colonIndex).trim().toLowerCase();
        if (prefix === GENERAL_BOT || includes(bots, prefix)) {
          flush();
          currentBot = prefix === GENERAL_BOT ? null : prefix;
          currentDirectives = RobotsMeta._parseDirectives(trimmed.slice(colonIndex + 1));
          flush();
          currentBot = null;
          return;
        }
      }
      currentDirectives = currentDirectives.concat(RobotsMeta._parseDirectives(trimmed));
    });
    flush();
    return entries;
  }

  /**
   * @param {!Array<!{name: !string, content: ?string}>} metas
   * @param {!Array<!string>} bots
   * @return {!Array<!{bot: ?string, directives: !Array<!string>}>}
   * @private
   */
  static _metaEntries(metas, bots) {
    if (!isArray(metas)) return [];
    const entries = [];
    metas.forEach(meta => {
      if (!meta || !isString(meta.name)) return;
      const name = meta.name.trim().toLowerCase();
      if (name === META_ROBOTS) {
        entries.push({ bot: null, directives: RobotsMeta._parseDirectives(meta.content) });
        return;
      }
      if (includes(bots, name)) {
        entries.push({ bot: name, directives: RobotsMeta._parseDirectives(meta.content) });
      }
    });
    return entries;
  }

  /**
   * Splits a comma-separated directive list. `none` is expanded into
   * `noindex` and `nofollow`, while `all` carries no restriction and is
   * dropped.
   *
   * @param {?string} content
   * @return {!Array<!string>}
   * @private
   */
  static _parseDirectives(content) {
    if (!content) return [];
    const directives = [];
    String(content).split(',').forEach(part => {
      const directive = part.trim().toLowerCase();
      if (!directive) return;
      if (directive === NONE_DIRECTIVE) {
        directives.push(NOINDEX_DIRECTIVE, NOFOLLOW_DIRECTIVE);
      } else if (directive !== ALL_DIRECTIVE) {
        directives.push(directive);
      }
    });
    return directives;
  }

  /**
   * General rules and the rules explicitly targeting the bot are merged.
   * Restrictive directives always win on conflict.
   *
   * @param {!string} bot
   * @param {!Array<!{bot: ?string, directives: !Array<!string>}>} entries
   * @return {!{noindex: !boolean, nofollow: !boolean}}
   * @private
   */
  static _policyFor(bot, entries) {
    const noindex = entries.some(entry => (
      (entry.bot === null || entry.bot === bot) && includes(entry.directives, NOINDEX_DIRECTIVE)
    ));
    const nofollow = entries.some(entry => (
      (entry.bot === null || entry.bot === bot) && includes(entry.directives, NOFOLLOW_DIRECTIVE)
    ));
    return { noindex, nofollow };
  }

  /**
   * Merges every bot's policy. When several bot names are configured, a
   * restriction applied to any of them is enforced conservatively.
   *
   * @param {!Object} policies
   * @return {!{noindex: !boolean, nofollow: !boolean}}
   * @private
   */
  static _mergePolicies(policies) {
    const list = Object.keys(policies).map(bot => policies[bot]);
    return {
      noindex: list.some(policy => policy.noindex),
      nofollow: list.some(policy => policy.nofollow),
    };
  }
}

module.exports = RobotsMeta;
