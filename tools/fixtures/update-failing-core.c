/* Isolated acceptance candidate: write AFTER the helper's backup, then fail.
 * Build with: cc -Wall -Wextra -Werror update-failing-core.c -lsqlite3 -o failing-core
 * The native executable preserves the helper's exact process-identity check.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sqlite3.h>
#include <unistd.h>

int main(int argc, char **argv) {
    const char *data = NULL;
    for (int i = 1; i + 1 < argc; i++) {
        if (!strcmp(argv[i], "--data-dir")) data = argv[i + 1];
    }
    if (!data) return 90;
    char resolved[4096], marker[4096], database[4096], expected[256];
    if (!realpath(data, resolved)) return 91;
    if (snprintf(database, sizeof(database), "%s/workspace.sqlite", resolved) >= (int)sizeof(database)) return 92;
    char *slash = strrchr(resolved, '/');
    if (!slash) return 93;
    *slash = '\0';
    if (snprintf(marker, sizeof(marker), "%s/acceptance-workspace-id", resolved) >= (int)sizeof(marker)) return 94;
    FILE *file = fopen(marker, "r");
    if (!file) return 95; /* Ordinary installations have no acceptance marker. */
    size_t count = fread(expected, 1, sizeof(expected) - 1, file);
    fclose(file);
    expected[count] = '\0';
    sqlite3 *db = NULL;
    if (sqlite3_open_v2(database, &db, SQLITE_OPEN_READWRITE, NULL) != SQLITE_OK) return 96;
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(db, "SELECT value FROM workspace_meta WHERE key='workspaceId'", -1, &statement, NULL) != SQLITE_OK) return 97;
    if (sqlite3_step(statement) != SQLITE_ROW) return 98;
    const unsigned char *actual = sqlite3_column_text(statement, 0);
    if (!actual || strcmp(expected, (const char *)actual)) return 99;
    sqlite3_finalize(statement);
    sqlite3_busy_timeout(db, 3000);
    if (sqlite3_exec(db, "BEGIN IMMEDIATE; CREATE TABLE update_fallback_sentinel(value TEXT); INSERT INTO update_fallback_sentinel VALUES('written-after-backup'); COMMIT;", NULL, NULL, NULL) != SQLITE_OK) return 100;
    sqlite3_close(db);
    /* Allow the parent to capture this real executable before controlled exit. */
    usleep(150000);
    return 23;
}
