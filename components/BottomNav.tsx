'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Umbrella, User } from 'lucide-react';

export const BottomNav: React.FC = () => {
  const pathname = usePathname();

  // Show bottom nav on dashboard or profile views
  const tabs = [
    { href: '/dashboard', label: 'Dashboard', Icon: Umbrella },
    { href: '/profile', label: 'Profile', Icon: User },
  ];

  return (
    <nav className="w-full bg-white border-t border-brand-100 px-6 pt-2 pb-3 flex items-center justify-around shrink-0 z-40 select-none font-body">
      {tabs.map(({ href, label, Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`flex flex-col items-center gap-1 py-1 px-5 transition ${
              active ? 'text-brand-600' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Icon className="w-5 h-5" />
            <span className={`text-xs ${active ? 'font-semibold' : 'font-medium'}`}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
};
