'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { MeResponse } from '@/lib/types';
import {
  beginStationRequest,
  clearStationCache,
  isCurrentStationRequest,
  restoreStationUser,
  setStationResponse,
  useStationCache,
} from '@/lib/stationCache';

// How often the station is refreshed (the server is asked at most this often)
const ACTIVE_MS = 5000;        // the student is looking at the page
const FAST_MS = 2000;          // a borrow/return is settling
const IDLE_MS = 15000;         // no interaction for a while
const IDLE_AFTER_MS = 2 * 60 * 1000;

/**
 * The signed-in student's station data (profile, slots, open loan), refreshed
 * while the page is visible. Polling pauses when the tab is hidden or the phone
 * is locked, refreshes as soon as it comes back, slows down when idle, and never
 * has two requests in flight. A 401 signs the student out.
 */
export function useStation({ fast = false }: { fast?: boolean } = {}) {
  const router = useRouter();
  const station = useStationCache();
  const inFlight = useRef(false);
  const lastInteraction = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fastRef = useRef(fast);
  fastRef.current = fast;

  const refresh = useCallback(async (): Promise<MeResponse | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    const request = beginStationRequest();
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      if (!isCurrentStationRequest(request)) return null;
      if (res.status === 401) {
        clearStationCache();
        localStorage.removeItem('astrix_user');
        sessionStorage.clear();
        router.replace('/login?notice=signed_out');
        return null;
      }
      const json: MeResponse = await res.json();
      if (!res.ok || !json.success) return null;
      setStationResponse(json, request);
      return json;
    } catch {
      return null; // offline for a moment: the next refresh tries again
    } finally {
      inFlight.current = false;
    }
  }, [router]);

  useEffect(() => {
    restoreStationUser();

    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      if (document.hidden) return; // resumes on visibilitychange
      const idle = Date.now() - lastInteraction.current > IDLE_AFTER_MS;
      const wait = fastRef.current ? FAST_MS : idle ? IDLE_MS : ACTIVE_MS;
      timer.current = setTimeout(async () => {
        await refresh();
        schedule();
      }, wait);
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (timer.current) clearTimeout(timer.current);
      } else {
        lastInteraction.current = Date.now();
        refresh().then(schedule);
      }
    };
    const onInteract = () => {
      const wasIdle = Date.now() - lastInteraction.current > IDLE_AFTER_MS;
      lastInteraction.current = Date.now();
      if (wasIdle) refresh().then(schedule);
    };

    refresh().then(schedule);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointerdown', onInteract, { passive: true });
    window.addEventListener('keydown', onInteract);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', onInteract);
      window.removeEventListener('keydown', onInteract);
    };
  }, [refresh]);

  return { me: station.me, user: station.me?.user ?? station.user, refresh };
}
