/*
 * DevFathom print window (DEV-973). Opened by src/lib/browser-print/print-window.ts.
 *
 * Opened with noopener, so the browser gives this window its own
 * browsing-context group (on https and on a plain-http LAN address alike): the
 * print dialog it opens pauses only this window, never the page that opened
 * it, and it has no reference back to that page. That page sends the finished,
 * escaped document over a BroadcastChannel named after the random id in this
 * URL's fragment; nothing about the document is in the URL, in storage or on
 * the server. This file carries no data of its own. It lives inside the counter
 * service worker's scope, which keeps a copy so offline printing still works.
 */
'use strict';
(function () {
  var CHANNEL_PREFIX = 'devfathom-print-window:';
  var ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Nothing arrived: the page that opened this window is gone.
  var ABANDONED_MS = 120000;
  // Attributes that take a URL a browser could navigate or run.
  var URL_ATTRIBUTES = ['href', 'src', 'xlink:href', 'srcdoc', 'data'];
  var id = String(location.hash || '').slice(1);
  if (!ID.test(id) || typeof BroadcastChannel !== 'function') return;
  try {
    history.replaceState(null, '', location.pathname);
  } catch (error) {
    // The id only names a channel; keeping it in history is harmless.
  }
  var channel = new BroadcastChannel(CHANNEL_PREFIX + id);
  var received = false;
  // Desktop Safari and iOS browsers can report afterprint while the
  // native sheet is still open. Wait for a focus round trip after print starts.
  var webKitPrintSheet =
    navigator.vendor === 'Apple Computer, Inc.' ||
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Version\/[\d.]+.*Safari\//i.test(navigator.userAgent) &&
      !/Chrome|Chromium|Edg|OPR/i.test(navigator.userAgent));
  var printStarted = false;
  var afterPrint = false;
  var lostFocus = false;
  var abandoned = setTimeout(function () {
    if (!received) closeSelf();
  }, ABANDONED_MS);

  function send(type) {
    try {
      channel.postMessage({ type: type });
    } catch (error) {
      // The opening page has gone; nothing to tell.
    }
  }

  // Said before closing: a message sent while the window is being torn down can be lost.
  function closeSelf() {
    send('closed');
    window.close();
  }

  function isScriptUrl(value) {
    // Browsers ignore control characters and spaces before the scheme.
    return /^javascript:/i.test(String(value).replace(/[\u0000- \u007f]+/g, ''));
  }

  /*
   * Defence in depth: the documents are built from escaped text, and this
   * page's Content-Security-Policy refuses inline script. Still, nothing that
   * can run, navigate or re-base this window survives into it.
   */
  function inert(doc) {
    var removed = doc.querySelectorAll(
      'script, meta[http-equiv], base, link, frame, frameset, iframe, object, embed, form, ' +
        'animate, animateMotion, animateTransform, set, discard, foreignObject'
    );
    for (var index = 0; index < removed.length; index += 1) removed[index].remove();
    var elements = doc.querySelectorAll('*');
    for (var e = 0; e < elements.length; e += 1) {
      var element = elements[e];
      // These documents use self-contained stylesheets. Reject a sheet
      // containing an import, including CSS-escaped at-keywords.
      if (element.localName === 'style' && /@(?:import\b|[a-z-]*\\)/i.test(element.textContent)) {
        element.remove();
        continue;
      }
      var names = element.getAttributeNames();
      for (var a = 0; a < names.length; a += 1) {
        var name = names[a];
        var lower = name.toLowerCase();
        if (
          lower.indexOf('on') === 0 ||
          lower === 'action' ||
          lower === 'formaction' ||
          (URL_ATTRIBUTES.indexOf(lower) !== -1 && isScriptUrl(element.getAttribute(name)))
        ) {
          element.removeAttribute(name);
        }
      }
    }
    return doc;
  }

  function show(html, chrome) {
    // Parsed, never executed: DOMParser documents run no scripts.
    var parsed = inert(new DOMParser().parseFromString(html, 'text/html'));
    // The button is screen chrome. Neither it nor its styles affect paper layout.
    var close = parsed.createElement('button');
    close.type = 'button';
    close.lang = 'en';
    close.id = 'devfathom-print-close';
    close.textContent = 'Close';
    var style = parsed.createElement('style');
    style.textContent =
      '@media screen { #devfathom-print-close { position: fixed; inset-inline-end: 8px; ' +
      'inset-block-end: 8px; z-index: 1; min-height: 44px; padding-inline: 12px; ' +
      'color: var(--text-strong, ButtonText); background: var(--surface-raised, ButtonFace); ' +
      'border: 1px solid var(--border-strong, ButtonBorder); border-radius: var(--radius-control); ' +
      'font-family: var(--font-sans, system-ui); font-size: 14px; cursor: pointer; } ' +
      '#devfathom-print-close:hover, #devfathom-print-close:active ' +
      '{ background: var(--surface-sunken, ButtonFace); } ' +
      '#devfathom-print-close:focus-visible { outline: 2px solid var(--ring, Highlight); ' +
      'outline-offset: 2px; } } @media print { #devfathom-print-close { display: none; } }';
    parsed.head.append(style);
    if (!parsed.body) parsed.documentElement.append(parsed.createElement('body'));
    parsed.body.append(close);

    if (chrome && typeof chrome === 'object') {
      [
        '--surface-raised',
        '--surface-sunken',
        '--text-strong',
        '--border-strong',
        '--radius-control',
        '--ring',
        '--font-sans',
      ].forEach(function (token) {
        if (typeof chrome[token] === 'string') close.style.setProperty(token, chrome[token]);
      });
    }
    close.addEventListener('click', closeSelf);
    document.replaceChild(document.adoptNode(parsed.documentElement), document.documentElement);
  }

  channel.onmessage = function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'focus') {
      window.focus();
      return;
    }
    if (message.type === 'close') {
      closeSelf();
      return;
    }
    if (message.type !== 'print' || received || typeof message.html !== 'string') return;
    received = true;
    clearTimeout(abandoned);
    show(message.html, message.chrome);
    window.focus();
    send('printing');
    // Printed from this window's own task, after the message has gone out.
    setTimeout(function () {
      try {
        printStarted = true;
        window.print();
      } catch (error) {
        // The document stays on screen; the browser's own Print still works.
      }
    }, 0);
  };

  if (webKitPrintSheet) {
    window.addEventListener('blur', function () {
      if (printStarted) lostFocus = true;
    });
    window.addEventListener('focus', function () {
      if (afterPrint && lostFocus) closeSelf();
      lostFocus = false;
    });
  }
  window.addEventListener('afterprint', function () {
    if (!received) return;
    if (!webKitPrintSheet) closeSelf();
    else if (printStarted) afterPrint = true;
  });
  window.addEventListener('pagehide', function () {
    send('closed');
  });
  send('ready');
})();
