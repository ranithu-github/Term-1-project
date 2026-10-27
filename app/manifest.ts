import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ASTRIX Umbrellas',
    short_name: 'ASTRIX',
    description: 'Borrow a campus umbrella at the University of Moratuwa. Return it within 24 hours.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#F5F8FC',
    theme_color: '#15345B',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
