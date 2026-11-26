import { useRef, useState } from 'react';
import './styles/tokens.css';
import './styles/theme-light.css';
import './styles/shell.css';
import './styles/stage.css';
import './styles/mesh.css';
import './styles/effects.css';
import './styles/log.css';
import { useReducedMotion } from './hooks/useReducedMotion.js';
import { useScrollProgress } from './hooks/useScrollProgress.js';
import { usePointerParallax } from './hooks/usePointerParallax.js';
import { useVisibility } from './hooks/useVisibility.js';
import SkipLink from './components/SkipLink.jsx';
import FloatingNav from './components/FloatingNav.jsx';
import HauntedStage from './components/HauntedStage.jsx';
import DefenseMesh from './components/DefenseMesh.jsx';
import AgentLogPill from './components/AgentLogPill.jsx';

/** The hand catches the skull once less than this share of the hero is visible. */
export const CATCH_THRESHOLD = 0.75;

/**
 * SPECTEROPS visual shell (Phase 4B.3B). Not mounted by the application yet; Phase 4B.3C wires it.
 *
 * It renders no <main> and no <h1>: the Dashboard passed as `children` owns both. Every value shown comes
 * from props; the shell fetches nothing, opens no EventSource and invents no data.
 *
 * Props:
 *   children          the existing Dashboard, wrapped in #so-dashboard (the skip-link target)
 *   connectionStatus  genuine SSE status for the nav chip (omit to hide the chip)
 *   health, incidents Defense Mesh data (see state/meshView.js)
 *   strike, heal      live effects (see state/liveEffects.js)
 *   animateChanges    true once live Events flow (history renders in steady state)
 *   logLines          from state/agentLog.js buildLogLines()
 *   summon            { onSummon, busy, disabled, notice, error } for SummonControl
 *   defaultTheme      'dark' (default) | 'light'
 */
export default function SpecterOpsShell({
  children = null,
  connectionStatus,
  health = null,
  incidents = [],
  strike = null,
  heal = null,
  animateChanges = false,
  logLines = [],
  summon = {},
  defaultTheme = 'dark',
}) {
  const rootRef = useRef(null);
  const stageRef = useRef(null);
  const [theme, setTheme] = useState(defaultTheme === 'light' ? 'light' : 'dark');
  const reducedMotion = useReducedMotion();
  useScrollProgress({ targetRef: rootRef }); // wordmark fade only
  usePointerParallax({ targetRef: rootRef }); // moon and wordmark drift
  const heroVisible = useVisibility(stageRef, CATCH_THRESHOLD);

  const nav = (
    <FloatingNav theme={theme} onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      connectionStatus={connectionStatus} summon={summon} />
  );

  return (
    <div ref={rootRef} className="specterops-shell" data-theme={theme} data-motion={reducedMotion ? 'reduced' : 'full'}
      data-testid="specterops-shell">
      <SkipLink />
      <HauntedStage ref={stageRef} nav={nav} caught={heroVisible === false} />
      <DefenseMesh health={health} incidents={incidents} strike={strike} heal={heal} animateChanges={animateChanges} />
      <div id="so-dashboard" className="so-dashboard-frame" tabIndex={-1}>
        {children}
      </div>
      <AgentLogPill lines={logLines} />
    </div>
  );
}
