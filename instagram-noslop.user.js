// ==UserScript==
// @name         Instagram NoSlop
// @namespace    https://github.com/local/instagram-noslop
// @version      2.2.0
// @description  Removes ads, suggested posts and the Explore/Reels tabs from Instagram, swaps the algorithmic home feed for the chronological Following feed, and covers reels shared in DMs. Built for iOS Safari via the Userscripts app.
// @author       local
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  Selector notes -- all verified against two real iOS Safari DOM captures of the
  logged-in mobile feed (Sept 2026 build), one at the top of the feed and one
  scrolled well past the end of followed content.

  - Posts are <article data-interactable="|click|">, direct children of a feed
    list <div> inside <main role="main">. No wrapper per post, so hiding the
    <article> itself is enough.
  - Ads on the MOBILE build are labelled "Ad" -- NOT "Sponsored". The label is a
    plain <span>Ad</span> in the post header with no decoy/hidden characters on
    this build. Ad posts additionally carry a facebook.com/ads/ig_redirect link
    and a_mpk= / enable_persistent_cta= query params.
  - Suggested posts are identified by a "Follow" button in the post header, NOT
    by any label. Once you scroll past the end of real content the "Suggested
    posts" divider is unmounted entirely and the suggestions that load carry no
    "Suggested for you" text anywhere -- a text rule catches none of them.
  - In-feed reels carry a permalink of the form /<user>/reel/<shortcode>/.
    Note /reels/audio/<id> appears in reels too but is a different segment.
  - Explore/Reels tabs are <a href="/explore/"> and <a href="/reels/"> in a tab
    bar outside <main>. Exact-match only: /explore/locations/... links appear
    inside legitimate posts as location tags and must NOT be touched.
  - "/" accepts a ?variant=following parameter and serves the chronological
    Following feed from it. Instagram's own logo dropdown links to exactly that
    URL, so it is a supported route, not a scraped one.
  - A reel shared into a DM renders as a card holding an author row and a
    thumbnail <img>, with an <svg aria-label="Clip"> badge over the thumbnail.
    There is no <video> and no /reel/ href anywhere in the thread, so the badge
    is the only handle. The composer's "Voice clip" button is a different label
    and must not match -- exact aria-label only, never a substring.
  - Each DM message is a <div role="group">, but left/right alignment lives in
    sibling spacer divs inside it, so the unit to replace is the card
    <div role="button" id="double_tappable_id.mid.$..."> -- blanking the group
    takes the spacers with it and the message jumps to the wrong side.
  - Class names are obfuscated and change every deploy -- none are used here.
*/

(function () {
  'use strict';

  /* ---------------------------------------------------------------------- */
  /* Config -- flip any of these off if a rule ever misfires                 */
  /* ---------------------------------------------------------------------- */
  var CONFIG = {
    hideReels: false,         // in-feed reels from accounts you follow. Off because
                              // your followed accounts post mostly reels -- turning
                              // this on empties the feed, which also stalls infinite
                              // scroll (no visible posts = no scroll height = no
                              // further loads). Suggested reels are still removed by
                              // the not-followed rule, and the Reels tab and /reels/
                              // route are still blocked regardless of this setting.
    hideAds: true,            // "Ad" / "Sponsored" / "Paid partnership" posts
    hideSuggested: true,      // posts from accounts you do not follow
    hideNavTabs: true,        // Explore + Reels tab-bar entries
    blockRoutes: true,        // bounce /explore/ and /reels/ back to the feed
    hideDmReels: true,        // replace reels shared into DMs with a line of text
    dmReelPlaceholder: 'Reel hidden',
    followingFeed: true,      // open on the chronological Following feed. Applies
                              // only to a real document load of "/" -- tapping
                              // Home in-app deliberately still goes to the home
                              // feed, which is where the stories tray lives.
    debug: false              // console.log every removal
  };

  var MARK = 'data-noslop';
  /* Deliberately a separate attribute: the MARK rule is display:none, and a
     covered reel has to keep its box so the bubble does not collapse. */
  var DM_MARK = 'data-noslop-dm';

  /* ---------------------------------------------------------------------- */
  /* Anti-flicker CSS, injected at document-start                            */
  /* Hiding via an attribute rule rather than inline style: React rewrites   */
  /* style attributes it manages, but leaves unknown data-* attributes be.   */
  /* ---------------------------------------------------------------------- */
  function injectCSS() {
    var css = '[' + MARK + ']{display:none !important}';
    if (CONFIG.hideNavTabs) {
      css += 'a[href="/explore/"],a[href="/reels/"]{display:none !important}';
    }
    if (CONFIG.hideDmReels) css += dmReelCSS();
    var style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function log() {
    if (CONFIG.debug) console.log.apply(console, ['[noslop]'].concat([].slice.call(arguments)));
  }

  function hide(el, reason) {
    if (!el || el.getAttribute(MARK) === reason) return;
    el.setAttribute(MARK, reason);
    log('hid', reason, el);
  }

  function unhide(el) {
    if (el && el.hasAttribute(MARK)) el.removeAttribute(MARK);
  }

  /* Visible text only. innerText respects hidden decoy spans, which is what a
     future "Sponsored"-style obfuscation would rely on; textContent would not. */
  function visibleText(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /* ---------------------------------------------------------------------- */
  /* Post classifiers                                                        */
  /* ---------------------------------------------------------------------- */

  var AD_LABELS = /^(ad|sponsored|paid partnership.*)$/i;

  function isAd(article) {
    /* Signal 1: a short standalone label in the post header. Only the first
       handful of spans are checked so a caption reading "Ad" can't trip it. */
    var spans = article.querySelectorAll('span');
    var limit = Math.min(spans.length, 40);
    for (var i = 0; i < limit; i++) {
      var t = visibleText(spans[i]);
      if (t.length <= 24 && AD_LABELS.test(t)) return 'ad-label';
    }
    /* Signal 2: ad plumbing in the outbound links. Survives any relabelling. */
    if (article.querySelector('a[href*="/ads/ig_redirect"]')) return 'ad-link';
    if (article.querySelector('a[href*="a_mpk="], a[href*="enable_persistent_cta="]')) return 'ad-param';
    return null;
  }

  function isReel(article) {
    /* The reel permalink. /reels/audio/<id> is a different segment and is not
       matched by this, so audio-attribution links on normal posts are safe. */
    var links = article.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      if (/\/reel\//.test(links[i].getAttribute('href') || '')) return 'reel';
    }
    return null;
  }

  /* The real signal for suggested content is a "Follow" button in the post
     header: Instagram only renders one when you do NOT already follow the
     author. Verified across two captures -- 12/12 suggested posts had one,
     0/3 posts from followed accounts did, and ads never do.

     "Following" must not match (that means you DO follow); "Follow back" must
     (they follow you, you do not follow them). Locale-dependent -- these
     strings are en-GB. */
  var FOLLOW_LABELS = /^(follow|follow back)$/i;

  function isNotFollowed(article) {
    var buttons = article.querySelectorAll('[role="button"]');
    var limit = Math.min(buttons.length, 12);   // the header button comes early
    for (var i = 0; i < limit; i++) {
      if (buttons[i].querySelector('[role="button"]')) continue;   // innermost only
      var t = visibleText(buttons[i]);
      if (t.length <= 16 && FOLLOW_LABELS.test(t)) return 'not-followed';
    }
    return null;
  }

  function isSuggestedPost(article) {
    var t = visibleText(article).slice(0, 200);
    if (/suggested for you|suggested post/i.test(t)) return 'suggested-label';
    return isNotFollowed(article);
  }

  /* ---------------------------------------------------------------------- */
  /* Pass 1: classify every post currently in the feed                       */
  /* Every article is re-evaluated on every pass rather than cached, because  */
  /* React recycles article elements between different posts as you scroll.   */
  /* ---------------------------------------------------------------------- */
  function filterPosts() {
    var articles = document.querySelectorAll('article');
    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      var reason = null;
      if (CONFIG.hideAds) reason = reason || isAd(a);
      if (CONFIG.hideReels) reason = reason || isReel(a);
      if (CONFIG.hideSuggested) reason = reason || isSuggestedPost(a);
      if (reason) hide(a, reason);
      else if (a.getAttribute(MARK) && a.getAttribute(MARK) !== 'past-divider') unhide(a);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Pass 2: the "Suggested posts" divider                                   */
  /* Only fires on a fresh load -- the divider is unmounted once you scroll   */
  /* past it, after which the Follow-button rule above does all the work.     */
  /* Cheap enough to keep for the case where it is present.                   */
  /* ---------------------------------------------------------------------- */
  var DIVIDER = /completely caught up|suggested posts|suggested for you/i;

  function filterSuggestedTail() {
    if (!CONFIG.hideSuggested) return;
    var firstArticle = document.querySelector('main article') || document.querySelector('article');
    if (!firstArticle) return;
    var list = firstArticle.parentElement;
    if (!list) return;

    var seenDivider = false;
    var kids = list.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (seenDivider) { hide(el, 'past-divider'); continue; }
      /* The divider is not an <article>; test only the non-post children so a
         real post whose caption says "suggested posts" can't sever the feed. */
      if (el.tagName !== 'ARTICLE' && DIVIDER.test(visibleText(el))) {
        seenDivider = true;
        hide(el, 'divider');
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Pass 3: Explore + Reels entries in the tab bar                          */
  /* ---------------------------------------------------------------------- */
  function filterNav() {
    if (!CONFIG.hideNavTabs) return;
    var links = document.querySelectorAll('a[href="/explore/"], a[href="/reels/"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.closest('article')) continue;   // never touch a link inside a post
      hide(tabItem(a), 'nav');
    }
  }

  /* Climb from the anchor to the tab bar's direct child, so the whole tab
     cell collapses instead of leaving an empty flex slot behind. */
  function tabItem(a) {
    var el = a;
    for (var i = 0; i < 6 && el.parentElement; i++) {
      if (el.parentElement.querySelectorAll('a[href]').length > 1) return el;
      el = el.parentElement;
    }
    return a;
  }

  /* ---------------------------------------------------------------------- */
  /* Pass 4: route guard                                                     */
  /* /explore/locations/ and /explore/tags/ stay reachable -- those are the   */
  /* location and hashtag pages linked from ordinary posts, not the Explore   */
  /* tab itself.                                                             */
  /* ---------------------------------------------------------------------- */
  function enforceRoutes() {
    if (!CONFIG.blockRoutes) return;
    var p = location.pathname;
    var blocked = /^\/explore(\/|$)/.test(p) || /^\/reels(\/|$)/.test(p);
    var allowed = /^\/explore\/(locations|tags)\//.test(p);
    if (blocked && !allowed) {
      log('blocked route', p);
      location.replace('/');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Pass 5: open on the chronological Following feed                        */
  /*                                                                         */
  /* "/" serves the Following feed from ?variant=following -- the same URL    */
  /* Instagram's own logo dropdown links to.                                  */
  /*                                                                         */
  /* This fires only on a real document load, never on an in-app tap of Home. */
  /* That is the whole design: driving Instagram's dropdown to get a reload-  */
  /* free SPA transition needs synthetic events, a portal poll and a mask,    */
  /* and the Following feed has no stories tray to arrive at anyway. Leaving  */
  /* in-app Home alone means Home stays the tray surface -- and, since the    */
  /* not-followed rule already strips it back to accounts you follow, a       */
  /* perfectly good second feed rather than a consolation prize.              */
  /* ---------------------------------------------------------------------- */

  var FOLLOWING_URL = '/?variant=following';
  var REDIRECT_GUARD = 'noslop:redirected';
  var REDIRECT_GUARD_MS = 5000;

  function preferFollowingFeed() {
    if (!CONFIG.followingFeed) return;
    if (location.pathname !== '/') return;
    if (/[?&]variant=/.test(location.search)) return;   // already on a variant

    var now = Date.now();
    try {
      /* Back on a bare "/" moments after redirecting means Instagram rewrote
         the URL. Don't bounce against it -- stay on the home feed. */
      if (now - (+sessionStorage.getItem(REDIRECT_GUARD) || 0) < REDIRECT_GUARD_MS) {
        log('redirect bounced, staying on the home feed');
        return;
      }
      sessionStorage.setItem(REDIRECT_GUARD, String(now));
    } catch (e) {
      log('redirect guard unavailable', e);
    }
    log('redirecting to', FOLLOWING_URL);
    location.replace(FOLLOWING_URL);
  }

  /* ---------------------------------------------------------------------- */
  /* Pass 6: reels shared into DMs                                           */
  /*                                                                         */
  /* A shared reel is a card with an author row and a thumbnail <img> under   */
  /* an <svg aria-label="Clip"> badge -- no <video>, and no /reel/ href in    */
  /* the thread, so the badge is the only handle on it.                       */
  /*                                                                         */
  /* The whole message collapses to a line of text. Done with a CSS rule on a */
  /* data-* attribute rather than an injected node, so nothing here competes  */
  /* with React for ownership of the DOM. Children are display:none rather    */
  /* than hidden so the bubble collapses instead of leaving a tall blank box. */
  /* ---------------------------------------------------------------------- */

  var DM_REEL_LABEL = 'Clip';
  /* Locale fallback. The aria-label is en-GB; the icon geometry is not. Only
     consulted when the label match finds nothing at all. */
  var DM_REEL_PATH = 'M22.942 7.464c-.062-1.36-.306-2.143-.511-2.671';

  function filterDmReels() {
    if (!CONFIG.hideDmReels) return;
    if (!/^\/direct(\/|$)/.test(location.pathname)) return;

    var badges = document.querySelectorAll('svg[aria-label="' + DM_REEL_LABEL + '"]');
    for (var i = 0; i < badges.length; i++) markDmReel(badges[i]);
    if (badges.length) return;

    var paths = document.querySelectorAll('svg[aria-label] > path');
    for (var j = 0; j < paths.length; j++) {
      if ((paths[j].getAttribute('d') || '').indexOf(DM_REEL_PATH) === 0) {
        markDmReel(paths[j].parentElement);
      }
    }
  }

  /* Replace the tappable card, NOT the enclosing <div role="group">. Left/right
     alignment is done with sibling spacer divs (--x-width:96px after the card,
     16px outside it), so blanking the whole group takes the spacers with it and
     the message loses its side. The card holds the author row and the
     thumbnail; the reaction sits outside it and survives. */
  function markDmReel(svg) {
    var card = svg.closest('[id^="double_tappable_id."]') || svg.closest('[role="group"]');
    if (!card || card.hasAttribute(DM_MARK)) return;
    card.setAttribute(DM_MARK, '');
    log('replaced dm reel');
  }

  /* !important throughout: Instagram's atomic classes (.x78zum5{display:flex}
     and friends) match at the same specificity as [attr]>*, and their sheet
     loads after this one, so without it they win on document order and the reel
     stays visible. pointer-events keeps the collapsed card from still opening
     the reel when tapped -- CSS can do that here because the card is the marked
     element itself, so there is no listener to hang off. */
  function dmReelCSS() {
    var D = '[' + DM_MARK + ']';
    return D + '{pointer-events:none !important}' +
           D + '>*{display:none !important}' +
           D + '::after{content:"' + cssString(CONFIG.dmReelPlaceholder) + '";' +
                 'display:inline-block !important;padding:8px 12px;border-radius:14px;' +
                 'font-size:12px;line-height:16px;background:#efefef;color:#737373}' +
           'html.__fb-dark-mode ' + D + '::after{background:#262626;color:#a8a8a8}';
  }

  /* Only quotes and backslashes need escaping inside a CSS string literal. */
  function cssString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /* ---------------------------------------------------------------------- */
  /* Scheduling                                                              */
  /* ---------------------------------------------------------------------- */
  var queued = false;
  function runSoon() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      try {
        enforceRoutes();
        filterPosts();
        filterSuggestedTail();
        filterNav();
        filterDmReels();
      } catch (e) {
        console.error('[noslop]', e);
      }
    });
  }

  /* Instagram is a pushState SPA: a one-shot pass at load would miss every
     in-app navigation, and lazily-loaded posts land after their neighbours. */
  function hookHistory() {
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      history[m] = function () {
        var r = orig.apply(this, arguments);
        runSoon();
        return r;
      };
    });
    window.addEventListener('popstate', runSoon);
  }

  /* Observation starts at document-start rather than DOMContentLoaded; the
     passes are all null-guarded so running them early is harmless. */
  injectCSS();
  enforceRoutes();
  preferFollowingFeed();   // once per document load, not per navigation
  hookHistory();
  if (document.documentElement) {
    new MutationObserver(runSoon).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
  runSoon();
})();
