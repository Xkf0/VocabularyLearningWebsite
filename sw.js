const CACHE_NAME = 'ebbinghaus-v3';
const STATIC_ASSETS = [
  './manifest.json',
  './icon.svg'
];

// 安装时缓存静态资源（不缓存 index.html，它始终从网络获取最新版）
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// 激活时清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(function() {
      // 接管页面并刷新，确保最新版本生效
      return self.clients.claim();
    }).then(function() {
      // 刷新所有已打开的页面以加载最新代码
      return self.clients.matchAll().then(function(clients) {
        clients.forEach(function(client) {
          client.navigate(client.url);
        });
      });
    })
  );
});

// 拦截请求：HTML 网络优先，静态资源缓存优先，API 不缓存
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API 请求不缓存，始终走网络
  if (url.pathname.includes('/api/')) {
    return;
  }

  // 非当前 origin 的请求不缓存
  if (url.origin !== self.location.origin) {
    return;
  }

  // HTML 文件：网络优先（始终获取最新版本）
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return caches.match(event.request).then(function(cached) {
          return cached || new Response('离线模式：请连接网络以加载最新内容', {
            status: 503,
            statusText: 'Offline'
          });
        });
      })
    );
    return;
  }

  // 其他静态资源：缓存优先，网络兜底
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      return cached || fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return new Response('离线模式：请连接网络以加载最新内容', {
          status: 503,
          statusText: 'Offline'
        });
      });
    })
  );
});
