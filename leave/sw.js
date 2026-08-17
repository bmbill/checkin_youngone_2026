/**
 * 2026 卓青營 請假系統 —— Service Worker
 *
 * 這支只做一件事：收推播、跳通知。
 * **刻意不快取任何檔案。**
 *
 * 為什麼要特別講：Service Worker 最常見的災難就是「改了 HTML，
 * 但手機上永遠是舊版」—— 因為 SW 把舊檔案快取住了。營期前一天發現
 * 有 bug 要改，結果幹部的手機怎麼重新整理都還是舊的，那會很難處理。
 * 這裡不碰 fetch 事件，所有檔案照瀏覽器原本的方式抓，不會有這個問題。
 *
 * 註冊時的 scope 是 ./（也就是 /leave/），所以碰不到報到頁和關懷員頁。
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = { title: '請假系統', body: '有新的更新，點開查看', url: './' };
  try {
    if (event.data) d = Object.assign(d, event.data.json());
  } catch (e) {
    // 解不開就用預設文字。至少要讓手機響一聲，不要整包吞掉。
  }

  event.waitUntil((async () => {
    /* 頁面正開著的時候也轉一份給它，讓它自己響鈴＋更新清單。
       通知還是照跳 —— 依照規範，收到推播就必須顯示通知，
       不顯示的話瀏覽器會自己跳一則「此網站在背景更新」的系統訊息，更糟。 */
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'push', title: d.title, body: d.body }));

    await self.registration.showNotification(d.title, {
      body: d.body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      // 同一個 tag 會蓋掉上一則，通知列不會塞出十幾則待簽核
      tag: 'lv',
      renotify: true,
      // 不自動消失。簽核的人放下手機十分鐘再回頭看，通知還要在
      requireInteraction: true,
      vibrate: [180, 90, 180],
      data: { url: d.url || './' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 已經開著就把它叫到前面，不要每次通知都開一個新分頁
    for (const c of all) {
      if (c.url.includes('/leave')) { await c.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
