import { recordRoomObjectWrite } from '@openscreeps/engine';
import { GameError, type GameState } from '../contracts.ts';
import { ownValue, roomController } from './support.ts';

/**
 * Upstream `/set-notify-when-attacked` for any room object the user owns (or, for unowned objects,
 * whose room controller the user owns). Upstream throws a `TypeError` for an unknown id.
 */
export function setNotifyWhenAttacked(
  state: GameState,
  userId: string,
  input: { id?: string | undefined; enabled: boolean },
): void {
  const { world } = state;
  const object = ownValue(world.roomObjects, input.id);
  if (!object) {
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
  recordRoomObjectWrite(world, object._id);
}
