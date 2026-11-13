#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

// The kernel releases flock on pipe EOF or process exit. Never unlink this inode:
// unlink/recreate-based stale-lock recovery can admit two concurrent owners.
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    int fd = open(argv[1], O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    struct stat info;
    if (fd < 0 || fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_nlink != 1 || info.st_uid != getuid()) return 2;
    if (flock(fd, LOCK_EX | LOCK_NB)) return 1;
    if (fchmod(fd, 0600)) return 2;
    puts("locked");
    fflush(stdout);
    char buffer[16];
    while (read(STDIN_FILENO, buffer, sizeof(buffer)) > 0) {}
    close(fd);
    return 0;
}
