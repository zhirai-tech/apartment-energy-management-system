import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@shared': path.resolve(__dirname, '../shared'),
        },
    },
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
                timeout: 180000,
                proxyTimeout: 180000,
                configure: function (proxy) {
                    proxy.on('proxyReq', function (proxyReq) {
                        proxyReq.setHeader('Connection', 'keep-alive');
                        proxyReq.setTimeout(180000);
                    });
                },
            },
            '/socket.io': {
                target: 'ws://localhost:3001',
                ws: true,
                changeOrigin: true,
                timeout: 180000,
                proxyTimeout: 180000,
            },
        },
    },
});
