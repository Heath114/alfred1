// Alfred.app's executable. macOS attaches privacy permissions (Full Disk Access, controlling
// Messages and Reminders) to the program that runs Alfred. With a plain `node`, that is the node
// binary, and every Node update silently drops the permissions; Apple's signed Node also can't ask
// to control other apps. So the LaunchAgent starts this small app instead, which keeps the
// permissions, and it starts Node as its child. Rebuilding it resets them, so setup only builds it
// when this file changes.
//
// Usage: Alfred <node> [node arguments...]
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

extern char **environ;
static pid_t child = 0;

static void forward(int sig) {
    if (child > 0) kill(child, sig);
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <node> [arguments...]\n", argv[0]);
        return 64;
    }
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = forward;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);

    // posix_spawn, not exec: this process stays the parent, so macOS keeps treating Alfred.app as
    // the program responsible for everything Node does.
    int err = posix_spawn(&child, argv[1], NULL, NULL, &argv[1], environ);
    if (err != 0) {
        fprintf(stderr, "Alfred: can't start %s: %s\n", argv[1], strerror(err));
        return 70;
    }
    int status = 0;
    while (waitpid(child, &status, 0) < 0) {
        if (errno != EINTR) return 71;
    }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    return 128 + WTERMSIG(status);
}
