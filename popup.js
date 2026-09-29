document.getElementById("open-site").addEventListener("click", () => {
  chrome.tabs.create({url: "https://onlineweb.zhihuishu.com/"});
});
