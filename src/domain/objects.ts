import { GameError, type GameState } from '../contracts.ts';
import { CONSTRUCTION_COST, ownValue, roomController } from './support.ts';

/**
 * Upstream `/set-notify-when-attacked` for a structure or creep the user owns (or, for unowned
 * structures, whose room controller the user owns).
 */
export function setNotifyWhenAttacked(
  state: GameState,
  userId: string,
  input: { id?: string | undefined; enabled: boolean },
): void {
  const { world } = state;
  const object = ownValue(world.roomObjects, input.id);
  if (
    !object ||
    !(
      Object.hasOwn(CONSTRUCTION_COST, object.type) ||
      object.type === 'creep' ||
      object.type === 'powerCreep'
    )
  ) {
    throw new GameError('invalid object');
  }
  if (object.user) {
    if (object.user !== userId) {
      throw new GameError('not owner');
    }
  } else if (roomController(world, object.room)?.user !== userId) {
    throw new GameError('not controller owner');
  }
  object.notifyWhenAttacked = input.enabled;
}
