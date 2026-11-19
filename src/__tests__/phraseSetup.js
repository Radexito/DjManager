import { setPhraseMask } from '../audio/phraseMask.js';

/**
 * 19 characters the tests use instead of the real table.
 *
 * The real table is read from the user's rekordbox installation and never
 * enters the repository, so nothing in the suite depends on its bytes.
 */
export const TEST_PHRASE_TABLE = 'AbCdEfGhIjKlMnOpQrS';

setPhraseMask(TEST_PHRASE_TABLE);
