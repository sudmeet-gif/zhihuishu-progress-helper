(() => {
  "use strict";
  if (!chrome?.runtime?.id) return;

  const defaults = {active: false, nextKnowledge: true};
  const isTop = window === window.top;
  const nextLabels = new Set(["下一节", "下一个视频", "下一课", "下一讲", "下一个资源", "下一资源", "下一学习资源"]);
  let settings = {...defaults};
  let panel = null;
  let statusNode = null;
  let progressNode = null;
  let lastStatus = "";
  let current = null;
  let listElement = null;
  let lastUrl = location.href;
  let courseKey = location.pathname.split("/")[2] || location.origin;
  let allDoneSince = 0;
  let lastKnowledgeNav = 0;
  let pendingKnowledgeUrl = "";
  let visitedModules = new Set();
  let boundVideos = new WeakSet();
  let genericStarts = new WeakMap();

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function label(element) {
    return String(element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || "")
      .trim().replace(/\s+/g, " ");
  }

  function hasBlockingDialog() {
    return [...document.querySelectorAll("[role=dialog],.el-dialog,.ant-modal,[class*=question-dialog],[class*=quiz-modal]")]
      .filter(visible).some(element => /题目|答题|测试|测验|验证码|验证|考试/.test(element.innerText || ""));
  }

  function report(message) {
    if (message === lastStatus) return;
    lastStatus = message;
    if (statusNode) statusNode.textContent = message;
  }

  function pause(message) {
    if (current?.type === "video") visibleVideo()?.pause();
    settings.active = false;
    chrome.storage.local.set({settings}).catch(() => {});
    renderSettings();
    report(message);
  }

  function readCards() {
    const list = document.querySelector(".resources-list");
    if (!list || !visible(list)) return null;
    const cards = [...list.children].filter(visible).map((element, index) => {
      const icon = element.querySelector(".icon-box");
      const type = icon?.classList.contains("video") ? "video"
        : icon?.classList.contains("book") || icon?.classList.contains("other") ? "document" : "unknown";
      const done = /已完成/.test(element.querySelector(".finished-icon")?.innerText || "");
      return {element, index, type, done, title: label(element.querySelector(".video-title") || element).slice(0, 80)};
    });
    return {list, cards};
  }

  function updateProgress(cards) {
    if (!progressNode) return;
    if (cards?.length) {
      const done = cards.filter(card => card.done).length;
      progressNode.textContent = `当前知识点资源：${done}/${cards.length} 已完成（以官网标识为准）`;
      return;
    }
    const text = document.body?.innerText || "";
    const match = text.match(/(?:学习|资源|课程)进度\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%/);
    progressNode.textContent = match ? `当前页显示进度：${match[1]}%` : "此页未识别到资源列表";
  }

  function visibleVideo() {
    return [...document.querySelectorAll("video")].find(visible) || null;
  }

  function waitForDialog() {
    const video = visibleVideo();
    if (video && !video.paused) video.pause();
    if (current?.type === "video") current.startKey = "";
    if (video) genericStarts.delete(video);
    report("检测到弹题或验证窗口，已暂停播放，等待你手动处理");
  }

  function playAtNormalSpeed(video, keyHolder) {
    if (video.playbackRate !== 1) video.playbackRate = 1;
    if (video.defaultPlaybackRate !== 1) video.defaultPlaybackRate = 1;
    const source = video.currentSrc || video.getAttribute("src") || "loading";
    if (!video.ended && video.paused && keyHolder.startKey !== source) {
      keyHolder.startKey = source;
      video.play().catch(async () => {
        if (!video.muted) {
          video.muted = true;
          try {
            await video.play();
            report("浏览器限制带声自动播放，已静音继续以 1× 播放");
            return;
          } catch { /* Fall through to manual playback message. */ }
        }
        report("浏览器拦截自动播放，请手动点击一次播放");
      });
    }
  }

  function bindVideo(video) {
    if (boundVideos.has(video)) return;
    boundVideos.add(video);
    video.addEventListener("ended", () => {
      if (current?.type === "video") current.endedAt = Date.now();
      else if (settings.active) setTimeout(() => genericAdvance("视频"), 3000);
    });
  }

  function selectCard(card) {
    if (card.type === "unknown") return pause("遇到未识别的资源类型，请手动处理该资源");
    current = {card: card.element, title: card.title, type: card.type, startedAt: Date.now(), endedAt: 0, retries: 0, startKey: ""};
    card.element.click();
    report(card.type === "video" ? `正在以 1× 速度播放：${card.title}` : `已打开课件：${card.title}；等待官网完成标识`);
  }

  function handleSelected(cards) {
    if (!current) return;
    const card = cards.find(item => item.element === current.card);
    if (!card) {current = null; return;}
    const elapsed = Date.now() - current.startedAt;
    if (current.type === "document") {
      if (card.done && elapsed >= 2500) {
        report(`官网已标记课件完成：${card.title}`);
        current = null;
      } else if (!card.done && elapsed > 15000) {
        pause(`课件尚未显示“已完成”：${card.title}；请手动检查`);
      }
      return;
    }
    const video = visibleVideo();
    if (!video) {
      if (elapsed > 30000) pause(`视频未能加载：${card.title}；请手动检查`);
      return;
    }
    bindVideo(video);
    playAtNormalSpeed(video, current);
    if (video.ended && !current.endedAt) current.endedAt = Date.now();
    if (!current.endedAt) return;
    if (card.done && Date.now() - current.endedAt >= 3000) {
      report(`官网已标记视频完成：${card.title}`);
      current = null;
    } else if (!card.done && Date.now() - current.endedAt > 15000) {
      if (current.retries === 0) {
        current.retries = 1;
        current.endedAt = 0;
        current.startedAt = Date.now();
        current.startKey = "";
        video.currentTime = 0;
        video.play().catch(() => pause(`视频重播失败：${card.title}`));
        report(`官网尚未标记完成，正在原速重播一次：${card.title}`);
      } else pause(`视频完整播放后仍未显示“已完成”：${card.title}；请手动检查`);
    }
  }

  function candidateKnowledgeRows() {
    const leaves = [...document.querySelectorAll("span,div,p,li")].filter(element => {
      if (!visible(element) || element.getBoundingClientRect().left > innerWidth * 0.35) return false;
      const text = (element.innerText || "").trim().replace(/\s+/g, " ");
      return text.length < 60 && /必学\s*\d+\s*\/\s*\d+/.test(text)
        && ![...element.children].some(child => /必学\s*\d+\s*\/\s*\d+/.test(child.innerText || ""));
    });
    return leaves.map(leaf => {
      const text = (leaf.innerText || "").replace(/\s+/g, " ");
      const match = text.match(/必学\s*(\d+)\s*\/\s*(\d+)/);
      let row = leaf;
      for (let i = 0; i < 4 && row.parentElement; i++) {
        const parent = row.parentElement;
        const rect = parent.getBoundingClientRect();
        if (rect.height > 95 || rect.width > 450) break;
        row = parent;
      }
      return {row, done: Number(match?.[1] || 0), total: Number(match?.[2] || 0), text: (row.innerText || "").trim().replace(/\s+/g, " ")};
    }).filter(item => item.total > item.done && item.total > 0);
  }

  function advanceKnowledgePoint() {
    if (!isTop || !settings.nextKnowledge || Date.now() - lastKnowledgeNav < 5000) return;
    if (pendingKnowledgeUrl === location.href) {
      if (Date.now() - lastKnowledgeNav < 20000) return;
      return pause("知识点切换后页面没有变化，请手动选择下一知识点");
    }
    const rows = candidateKnowledgeRows();
    const currentTitle = label(document.querySelector("h1") || document.querySelector(".knowledge-title") || document.body).slice(0, 80);
    const target = rows.find(item => !/\b(active|selected|current)\b/.test(String(item.row.className || ""))
      && (!currentTitle || !item.text.includes(currentTitle)));
    if (target) {
      lastKnowledgeNav = Date.now();
      pendingKnowledgeUrl = location.href;
      target.row.click();
      report(`已尝试打开下一未完成知识点：${target.text.slice(0, 50)}`);
      return;
    }
    const headers = [...document.querySelectorAll(".el-collapse-item__header")].filter(visible);
    const collapsed = headers.map((element, index) => ({element, key: `${index}:${label(element)}`}))
      .find(item => !item.element.classList.contains("is-active") && !visitedModules.has(item.key));
    if (collapsed) {
      visitedModules.add(collapsed.key);
      lastKnowledgeNav = Date.now();
      collapsed.element.click();
      report(`正在检查知识模块：${label(collapsed.element).slice(0, 40)}`);
      return;
    }
    pause("当前课程可识别的资源已完成；请核对课程总进度并切换下一门课");
  }

  function handleResourceList(data) {
    if (data.list !== listElement) {listElement = data.list; current = null; allDoneSince = 0;}
    updateProgress(data.cards);
    if (!settings.active) return;
    if (hasBlockingDialog()) return waitForDialog();
    if (current) return handleSelected(data.cards);
    const next = data.cards.find(card => !card.done);
    if (next) {allDoneSince = 0; selectCard(next); return;}
    if (!allDoneSince) {allDoneSince = Date.now(); report("当前知识点的资源均显示已完成"); return;}
    if (Date.now() - allDoneSince >= 5000) advanceKnowledgePoint();
  }

  function genericAdvance(reason) {
    if (!isTop || !settings.active || hasBlockingDialog()) return;
    const candidates = [...document.querySelectorAll("button,[role=button],a")].filter(element => visible(element) && nextLabels.has(label(element)));
    if (candidates.length !== 1) return report(`${reason}已播放结束；请手动打开下一资源`);
    candidates[0].click();
    report(`${reason}已播放结束，已尝试打开下一资源`);
  }

  function handleGenericVideo() {
    if (!settings.active) return;
    if (hasBlockingDialog()) return waitForDialog();
    const video = visibleVideo();
    if (!video) return;
    bindVideo(video);
    let holder = genericStarts.get(video);
    if (!holder) {holder = {startKey: ""}; genericStarts.set(video, holder);}
    playAtNormalSpeed(video, holder);
  }

  function renderSettings() {
    if (!panel) return;
    const root = panel.shadowRoot;
    root.getElementById("toggle").textContent = settings.active ? "暂停" : "启动";
    root.getElementById("knowledge").checked = settings.nextKnowledge;
  }

  async function saveSettings(patch) {
    if (settings.active && patch.active === false) visibleVideo()?.pause();
    settings = {...settings, ...patch};
    current = null;
    genericStarts = new WeakMap();
    await chrome.storage.local.set({settings});
    renderSettings();
  }

  function createPanel() {
    if (!isTop || panel || !document.body) return;
    panel = document.createElement("div");
    panel.id = "zhs-progress-helper";
    panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = panel.attachShadow({mode: "open"});
    root.innerHTML = `
      <style>
        *{box-sizing:border-box}.box{font:13px/1.45 system-ui,sans-serif;color:#13202c;background:#fff;border:1px solid #b8c9d8;border-radius:12px;box-shadow:0 8px 25px #0003;width:300px;padding:12px}
        h2{font-size:15px;margin:0 0 8px}.row{display:flex;gap:7px;margin:7px 0;align-items:center}button{cursor:pointer;border:1px solid #a9bfce;border-radius:7px;background:#f3f8fb;padding:6px 8px;color:#13202c;flex:1}button.primary{background:#145cc4;color:#fff;border-color:#145cc4}
        label{display:flex;align-items:center;gap:4px}small{display:block;color:#526373}#status{min-height:35px;margin-top:8px;word-break:break-word}
      </style>
      <div class="box"><h2>智慧树资源进度助手</h2><div id="progress"></div>
        <div class="row"><button id="toggle" class="primary">启动</button><button id="check">检查本页</button></div>
        <div class="row"><label><input id="knowledge" type="checkbox">完成后检查下一知识点</label></div>
        <small>视频始终 1× 播放；Word/PPT 点开后核对“已完成”。弹题由本人处理。</small><div id="status"></div>
      </div>`;
    document.body.append(panel);
    statusNode = root.getElementById("status");
    progressNode = root.getElementById("progress");
    root.getElementById("toggle").addEventListener("click", () => saveSettings({active: !settings.active}));
    root.getElementById("knowledge").addEventListener("change", event => saveSettings({nextKnowledge: event.target.checked}));
    root.getElementById("check").addEventListener("click", () => {
      updateProgress(readCards()?.cards);
      report("已重新读取本页，请核对官网完成标识");
    });
    renderSettings();
  }

  chrome.storage.local.get(["settings"]).then(data => {
    settings = {...defaults, ...(data.settings || {})};
    createPanel();
    if (statusNode) statusNode.textContent = "等待启动";
  });
  chrome.storage.local.remove("lastStatus").catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {settings = {...defaults, ...(changes.settings.newValue || {})}; renderSettings();}
  });
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      current = null;
      listElement = null;
      allDoneSince = 0;
      pendingKnowledgeUrl = "";
      const nextCourseKey = location.pathname.split("/")[2] || location.origin;
      if (nextCourseKey !== courseKey) {courseKey = nextCourseKey; visitedModules = new Set();}
    }
    createPanel();
    const data = readCards();
    if (data?.cards.length) handleResourceList(data);
    else {updateProgress(null); handleGenericVideo();}
  }, 2000);
})();
