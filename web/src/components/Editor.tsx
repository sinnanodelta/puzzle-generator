// The editor (SPEC §7): pieces on the left, the layer view and the 3D view side by side, or the 3D
// view alone.
import { useStore } from '../store';
import { LayerView } from './LayerView';
import { PieceList } from './PieceList';
import { Scene3D } from './Scene3D';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';

export function Editor() {
  const showLayers = useStore((s) => s.showLayers);
  return (
    <div className={showLayers ? 'editor' : 'editor no-layers'}>
      <Toolbar />
      <PieceList />
      {showLayers && <LayerView />}
      <div className="scene-panel">
        <Scene3D />
      </div>
      <StatusBar />
    </div>
  );
}
