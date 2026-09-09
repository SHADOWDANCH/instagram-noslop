# Instagram NoSlop

A single-file userscript that strips ads, suggested posts, and the Explore/Reels tabs out of
Instagram, opens on the chronological Following feed, and replaces reels shared into DMs with
a line of text.

It keeps Instagram's own layout. It is a filter, not an alternative client — posts, stories,
likes, comments, carousels and video all behave exactly as they normally do.

Built for **iPhone / iOS Safari**, where Tampermonkey does not exist.

---

## What it removes

| | Default | Notes |
|---|---|---|
| Sponsored / "Ad" posts | on | Matches the label, plus ad-redirect links and tracking params as backup |
| Suggested posts | on | Any post from an account you don't follow |
| Explore + Reels tab entries | on | Removed from the tab bar |
| `/explore/` and `/reels/` routes | on | Bounced back to the feed if you land there anyway |
| Reels shared in DMs | on | Whole message card replaced with "Reel hidden", not tappable |
| Chronological Following feed | on | Opens there instead of the algorithmic home feed |
| In-feed reels | **off** | See [In-feed reels](#in-feed-reels-are-off-by-default) below |

The Explore and Reels *routes* stay blocked regardless of the in-feed reels setting.

`/explore/locations/…` and `/explore/tags/…` are deliberately left reachable — those are the
location and hashtag pages linked from ordinary posts, not the Explore tab.

## Requirements

This is an iOS-first script, and the platform constraints are not negotiable:

- **A userscript manager that is a Safari Web Extension** — [Userscripts][userscripts] (free,
  open source) or Stay. Tampermonkey cannot run on iOS; Apple does not allow that extension
  architecture there, and every iOS browser is required to use WebKit, so Chrome or Firefox
  for iOS will not help either.
- **A regular Safari tab.** Safari extensions do not inject into the isolated container used
  by an "Add to Home Screen" web app. A chromeless home-screen icon and a working userscript
  are mutually exclusive on iOS; the visible Safari toolbar is the tradeoff. You can still
  install the home-screen web app alongside it — see [Notifications](#notifications).

The script uses only `@match`, `@run-at` and `@grant none` — no `GM_*` APIs, which
Userscripts and Stay implement incompletely.

It also runs on desktop Safari, Chrome and Firefox with Tampermonkey or Violentmonkey, but
every selector was verified against the **mobile** DOM. The desktop build's markup differs in
places, so treat desktop as untested.

[userscripts]: https://github.com/quoid/userscripts

## Install

1. Install **Userscripts** from the App Store.
2. Open the Userscripts app and pick a scripts directory (any folder in Files or iCloud
   Drive).
3. Put `instagram-noslop.user.js` in that folder — or open the app, create a new script, and
   paste the file's contents in.
4. **Settings → Apps → Safari → Extensions → Userscripts** → turn it on, then set
   instagram.com to **Always Allow**.
5. Open `instagram.com` in a normal Safari tab.

To update, replace the file and reload the tab.

## Notifications

iOS only delivers web push to a site that has been **added to the Home Screen**, and that
home-screen web app is exactly the isolated container Safari extensions cannot inject into.
So notifications and the userscript cannot come from the same place — you need both
installed, doing different jobs:

- the **home-screen web app** exists only to receive notifications
- **Safari** is where you actually browse, with the script running

Setup:

1. Open `instagram.com` in Safari → **Share** → **Add to Home Screen**.
2. Open that new icon once. It has its own storage, separate from Safari, so you will
   probably have to log in again there.
3. Allow notifications when prompted — or turn them on from Instagram's own settings inside
   that window. Then close it.
4. Do your actual browsing in Safari. Keep a bookmark or a pinned tab for `instagram.com`.

**Tapping a notification opens the home-screen app, not Safari** — and the script does not
run there, so that view will have ads, reels and suggestions. Read the notification, then
switch to Safari to browse. If the icon is easy to tap by mistake, move it into a folder or
the App Library and keep the Safari bookmark on your home screen instead.

## Configuration

Every rule is a flag in the `CONFIG` block at the top of the file. Flip any of them if a rule
ever misfires:

```js
var CONFIG = {
  hideReels: false,         // in-feed reels from accounts you follow
  hideAds: true,            // "Ad" / "Sponsored" / "Paid partnership" posts
  hideSuggested: true,      // posts from accounts you do not follow
  hideNavTabs: true,        // Explore + Reels tab-bar entries
  blockRoutes: true,        // bounce /explore/ and /reels/ back to the feed
  hideDmReels: true,        // replace reels shared into DMs with a line of text
  dmReelPlaceholder: 'Reel hidden',
  followingFeed: true,      // open on the chronological Following feed
  debug: false              // console.log every removal, with its reason
};
```

Set `debug: true` to log every removal and the rule that caused it (`ad-label`, `ad-link`,
`ad-param`, `not-followed`, `suggested-label`, `reel`, `divider`, `past-divider`, `nav`).
That is the fastest way to find out which rule broke when Instagram changes its markup.

### How the Following feed works

Instagram serves the chronological feed from `/?variant=following` — the same URL its own
logo dropdown links to. On a real page load of `/`, the script redirects there.

**Tapping Home in the app is deliberately left alone.** That gives you:

```
Open the app  ->  Following feed (chronological)
Tap Home      ->  filtered home feed + the real stories tray
```

## How it works

Instagram is a `pushState` single-page app whose CSS class names are obfuscated and change
every deploy, so:

- **No class names are used anywhere.** Rules key on `role`, `aria-label`, `href` patterns,
  `data-pagelet`, and visible text.
- **Nothing is cached.** Every post is re-classified on every pass, because React recycles
  `<article>` elements between different posts as you scroll.
- **A `MutationObserver` drives everything**, throttled to one pass per animation frame, plus
  hooks on `pushState`/`replaceState`/`popstate` so in-app navigation is caught.
- **Hiding is done with a `data-*` attribute and one CSS rule**, never inline styles. React
  rewrites style attributes it manages, but leaves unknown `data-*` attributes alone.
- **No nodes are ever injected into Instagram's DOM**, so nothing competes with React for
  ownership of the tree.

## Known limitations

- **Locale.** Selectors were verified against an `en-GB` session. `Follow`, `Follow back` and
  the DM reel badge's `Clip` label are locale-dependent and are the most likely first
  breakage point. The DM rule has a locale-independent fallback (the badge's SVG path
  geometry); the feed rules do not.
- **Markup churn.** Everything here was verified against the September 2026 mobile build.
  Instagram changes its markup often. `debug: true` will tell you which rule stopped firing.
- **Desktop is untested.** See [Requirements](#requirements).

Nothing here touches network requests, credentials, or Instagram's API. It only hides DOM
that is already on the page, and follows one URL that Instagram's own UI links to.
