import { AttackDataPayload } from '@app/payloads/incoming';
import {
  getCellCoverageForOriginOrientationAndArea,
  getRandomShipLayout,
  isSameOrigin
} from '@app/utils';
import {
  CellPosition,
  Orientation,
  ShipSize,
  ShipPositionData,
  ShipType
} from '@app/game/types';
import Model from './model';
import { AttackResult, AttackResultHitDestroy } from '@app/payloads/common';
import log from '@app/log';

/**
 * The location and hit status of a ship cell. A ship will cover multiple cells
 * on the board, so we track them individually over time.
 */
type StoredShipDataCell = {
  origin: CellPosition;
  hit: boolean;
  type: ShipType;
};

/**
 * Player attacks are stored. These are used by the client to render the game
 * board at any point in time.
 */
type StoredAttackData = {
  ts: number;
  attack: AttackDataPayload;
  result: AttackResult;
};

/**
 * The ship data that is stored includes the cells and their current state,
 * i.e if they have been hit by an attack
 */
export type StoredShipData = {
  sunk: boolean;
  type: ShipType;
  origin: CellPosition;
  orientation: Orientation;
  cells: StoredShipDataCell[];
};

/**
 * Container type to store player ship position data.
 */
export type PlayerPositionData = {
  [key in ShipType]: StoredShipData;
};

/**
 * The opponent ship placements (from the perspective of another player) are
 * only revealed after the particular ship has been completely destroyed
 */
type OpponentPositionData = {
  valid: boolean;
  positions: {
    [key in ShipType]?: StoredShipData;
  };
};

/**
 * A player's board data must be validated. So we store it alongside a flag
 * that indicates if it has passed validation.
 */
type MatchPlayerBoardData = {
  valid: boolean;
  positions: PlayerPositionData;
};

/**
 * A representation of the overall Player state. This is the type of data that
 * inifinispan will hold for a Player instance, and is used to instantiate a
 * Player object from cache entries.
 */
export type MatchPlayerData = {
  uuid: string;
  username: string;
  score: number;
  isAi: boolean;
  match: string;
  board: MatchPlayerBoardData;
  attacks: StoredAttackData[];
};

/**
 * Similar to PlayerData, but contains a sanitised version of data top prevent
 * a nefarious player from getting an upper hand by inspecting packets.
 */
export type MatchOpponentData = {
  username: string;
  attacks: StoredAttackData[];
  board: OpponentPositionData;
};

export default class MatchPlayer extends Model<MatchPlayerData> {
  private board: MatchPlayerBoardData;
  private attacks: StoredAttackData[];
  private username: string;
  private isAi: boolean;
  private match: string;
  private score: number;

  constructor(opts: {
    username: string;
    isAi: boolean;
    uuid: string;
    match: string;
    score: number;
    board?: MatchPlayerBoardData;
    attacks?: StoredAttackData[];
  }) {
    super(opts.uuid);

    this.match = opts.match;
    this.attacks = opts.attacks || [];
    this.score = isNaN(opts.score) ? 0 : opts.score;
    this.username = opts.username;
    this.isAi = opts.isAi;

    if (opts.board) {
      this.board = opts.board;
    } else {
      // Create a default set of valid, but not unconfirmed positions. The
      // end-user will need to confirm them via the UI
      this.board = {
        valid: false,
        positions: createPositionDataWithCells(getRandomShipLayout())
      };
    }
  }

  static from(data: MatchPlayerData) {
    log.trace('creating MatchPlayer instance from data: %j', data);
    return new MatchPlayer(data);
  }

  isAiPlayer() {
    return this.isAi;
  }

  hasAttacked() {
    return this.attacks.length > 0;
  }

  hasAttackedLocation(origin: CellPosition): boolean {
    return !!this.attacks.find((a) => isSameOrigin(a.attack.origin, origin));
  }

  getShipPositionData() {
    return this.board?.positions;
  }

  hasLockedValidShipPositions() {
    return this.board?.valid;
  }

  setMatchInstanceUUID(uuid: string) {
    log.trace(`setting player ${this.getUUID()} match UUID to ${uuid}`);
    this.match = uuid;
  }

  getUsername() {
    return this.username;
  }

  getMatchInstanceUUID() {
    return this.match;
  }

  /**
   * Return the number of shots that this player has fired so far.
   */
  getShotsFiredCount() {
    return this.attacks.length;
  }

  /**
   * Return the number of successive shots in a row that have been successful
   * hits. This could be zero for most of the game if the player is unfortunate
   * or unattentive.
   */
  getContinuousHitsCount() {
    // Sort the attacks in order of most recent first
    const attacksInTimeOrder = this.attacks
      .slice()
      .sort((a, b) => (a.ts > b.ts ? -1 : 1));

    // Then increase the counter for each successful hit, then break the
    // loop once a miss is detected
    let count = 0;
    for (const atk of attacksInTimeOrder) {
      if (atk.result.hit) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  incrementScoreBy(amount: number) {
    return (this.score += amount);
  }

  getScore() {
    return this.score;
  }

  /**
   * Take a validated set on incoming ship positions, initialise them for game
   * logic, and store on this player instance.
   * @param data
   * @param valid
   */
  setShipPositionData(data: ShipPositionData, valid: boolean) {
    log.debug(
      `setting ship position data (valid: ${valid}) for player ${this.getUUID()} to: %j`,
      data
    );

    this.board = {
      valid,
      positions: createPositionDataWithCells(data)
    };
  }

  /**
   * Determines if a given attack at an origin will hit/miss. It the attack is
   * deemed to be a hit, it will also determine if it destroyed a ship.
   *
   * This is called if this player is the recipient of an attack.
   */
  determineAttackResult({ origin }: AttackDataPayload): AttackResult {
    const { positions } = this.board;

    for (const key in positions) {
      const ship = positions[key as ShipType];

      if (!ship.sunk) {
        const hitCell = ship.cells.find((c) => isSameOrigin(c.origin, origin));

        if (hitCell) {
          hitCell.hit = true;

          const destroyed = ship.cells.reduce((_destroyed: boolean, v) => {
            return _destroyed && v.hit;
          }, true);

          if (destroyed) {
            log.trace(`marking ${ship.type} as sunk for ${this.getUUID()}`);
            ship.sunk = true;
          }

          return {
            ...hitCell,
            destroyed
          } as AttackResultHitDestroy;
        }
      }
    }

    return {
      hit: false,
      origin
    };
  }

  /**
   * Records the result of an attack in this player record. This is called if
   * this player was the one making the attack.
   */
  recordAttackResult(attack: AttackDataPayload, result: AttackResult) {
    this.attacks.push({
      ts: Date.now(),
      attack,
      result
    });
  }

  /**
   * Generates a JSON object that has secret information redacted. This is
   * necessary since players need to know certain information about their
   * opponent, but we don't want to expose ship locations and other data
   */
  toOpponentJSON(): MatchOpponentData {
    const board: OpponentPositionData = {
      valid: this.board.valid,
      positions: {}
    };
    const positions = this.board.positions;

    if (positions) {
      Object.values(positions).forEach((ship) => {
        if (ship.sunk) {
          // Ship is only revealed if sunk
          board.positions[ship.type] = ship;
        }
      });
    }
    log.trace(`revealing ships for player ${this.getUUID()}: %j`, board);
    return {
      username: this.username,
      attacks: this.attacks.map((a) => {
        const atk = {
          ...a
        };

        // Remove prediction data from outgoing messages
        delete a.attack.prediction;

        return atk;
      }),
      board
    };
  }

  /**
   * Returns a JSON object that is used to serialise this Player instance for
   * storage in the infinispan cache, or to be sent via WebSocket
   */
  toJSON(): MatchPlayerData {
    return {
      board: this.board,
      isAi: this.isAi,
      username: this.username,
      match: this.getMatchInstanceUUID(),
      attacks: this.attacks,
      score: this.score,
      uuid: this.getUUID()
    };
  }
}

/**
 * Take basic ShipPositionData and explode out the cells that each of the
 * provided ships occupy, i.e the x,y coordinates that it covers.
 * @param data
 */
function createPositionDataWithCells(
  data: ShipPositionData
): PlayerPositionData {
  return Object.keys(data).reduce((updated, _type) => {
    const type = _type as ShipType;
    const shipData = data[type];

    const cells = getCellCoverageForOriginOrientationAndArea(
      shipData.origin,
      shipData.orientation,
      ShipSize[type]
    );

    updated[type] = {
      sunk: false,
      ...shipData,
      type,
      cells: cells.map((origin) => {
        return {
          hit: false,
          origin,
          type
        };
      })
    };

    return updated;
  }, {} as PlayerPositionData);
}
