// Download buttons: point them at the newest MSI. Its file name carries the version, so there is no
// fixed "latest" address. Until GitHub answers, or if it does not, they open the latest release page.
(() => {
  const links = document.querySelectorAll('[data-msi]');
  const note = document.querySelector('[data-release-note]');

  fetch('https://api.github.com/repos/jedbjorn/drive-it/releases/latest')
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(response.status))))
    .then((release) => {
      const msi = release.assets.find((asset) => asset.name.endsWith('.msi'));
      if (!msi) {
        return;
      }

      links.forEach((link) => {
        link.href = msi.browser_download_url;
      });
      if (note) {
        note.textContent = `${release.name} · ${Math.round(msi.size / 1048576)} MB`;
        note.hidden = false;
      }
    })
    .catch(() => {});
})();

// The video: a poster until YouTube says the video is public, then a play button. Nothing loads from
// YouTube's player until the visitor presses play.
(() => {
  const video = document.querySelector('.video[data-youtube-id]');
  const id = video && video.dataset.youtubeId;
  if (!id) {
    return;
  }

  const liveAt = Date.parse(video.dataset.liveAt);
  const play = video.querySelector('.video-play');
  const soon = video.querySelector('.video-soon');
  const link = document.querySelector('.video-link');
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;

  if (Date.now() < liveAt) {
    const when = new Date(liveAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    soon.textContent = `Video goes live ${when}`;
  }

  play.addEventListener('click', () => {
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`;
    frame.title = 'Drive-It (YouTube)';
    frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.allowFullscreen = true;
    video.replaceChildren(frame);
  });

  const check = async () => {
    let live;
    try {
      // 200 for a public or unlisted video; 401, 403 or 404 for a private, scheduled or missing one.
      const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`, { cache: 'no-store' });
      live = response.ok;
    } catch {
      // The check itself was blocked (an ad blocker, a firewall). Go by the clock if there is one.
      live = Date.now() >= liveAt;
    }

    if (!live) {
      window.setTimeout(check, 60000);
      return;
    }

    soon.hidden = true;
    play.hidden = false;
    link.href = watchUrl;
    link.hidden = false;
  };

  check();
})();

// Reveal sections as they scroll into view.
(() => {
  const groups = [
    ['.hero-copy > *', 70],
    ['.hero-shot', 0],
    ['.fact-grid > div', 80],
    ['.section-heading > *', 70],
    ['.stat', 70],
    ['.result-grid > figure', 90],
    ['.feature-card', 70],
    ['.step-grid > li', 90],
    ['.panel-grid > *', 100],
    ['.docs-intro > *', 60],
    ['.doc-links > a', 60],
    ['.download-card > *', 100],
  ];

  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }

      const element = entry.target;
      const delay = Number.parseInt(element.style.getPropertyValue('--reveal-delay'), 10) || 0;
      element.classList.add('is-revealed');
      observer.unobserve(element);
      window.setTimeout(() => {
        element.classList.remove('is-revealed');
        element.removeAttribute('data-reveal');
        element.style.removeProperty('--reveal-delay');
      }, delay + 800);
    }
  }, {
    rootMargin: '0px 0px -8% 0px',
    threshold: 0.08,
  });

  for (const [selector, stagger] of groups) {
    document.querySelectorAll(selector).forEach((element, index) => {
      element.dataset.reveal = '';
      element.style.setProperty('--reveal-delay', `${Math.min(index, 2) * stagger}ms`);
      observer.observe(element);
    });
  }

  document.documentElement.classList.add('reveal-ready');
})();
