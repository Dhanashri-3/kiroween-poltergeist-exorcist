import { useReducer } from 'react';
import { reduce, initialState } from './state/dashboardReducer.js';
import { useEventStream } from './hooks/useEventStream.js';
import Dashboard from './components/Dashboard.jsx';

export default function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const { status, error, lastSeq, startChaos, reset } = useEventStream({ dispatch });
  return (
    <Dashboard
      state={state}
      connection={{ status, error, lastSeq }}
      onStartChaos={startChaos}
      onReset={reset}
    />
  );
}
