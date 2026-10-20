import {createRouter, createWebHistory} from 'vue-router'

// Real paths, not hashes. GitHub Pages has no SPA rewrite, so the build leaves
// a copy of index.html at 404.html (vite.config.ts) and unmatched paths boot
// the app with the URL intact. The canvas's own position rides in the query
// (?x=&y=&z=), so a shared link opens on the same pixels.
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {path: '/', name: 'canvas', component: () => import('./pages/CanvasPage.vue')},
    {path: '/about', name: 'about', component: () => import('./pages/AboutPage.vue')},
    // The canvas alone, full screen, for watching it move. meta.bare tells
    // App.vue to draw no header, footer or banner around it.
    {path: '/gallery', name: 'gallery', component: () => import('./pages/GalleryPage.vue'), meta: {bare: true}},
    {path: '/:pathMatch(.*)*', name: 'notfound', component: () => import('./pages/NotFoundPage.vue')},
  ],
})
