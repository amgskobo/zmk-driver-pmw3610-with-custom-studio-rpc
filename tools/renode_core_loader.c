/* Test-only native loader for the pinned Linux x86_64 Renode container. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int replace_library(const char *path, const char *replacement) {
    char temporary[4096];
    if (snprintf(temporary, sizeof(temporary), "%s.core-%d", path, (int)getpid()) >=
        (int)sizeof(temporary)) {
        return -1;
    }
    int source = open(replacement, O_RDONLY);
    int target = source < 0 ? -1 : open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0600);
    int result = source < 0 || target < 0 ? -1 : 0;
    char buffer[65536];
    ssize_t count = 0;
    while (!result && (count = read(source, buffer, sizeof(buffer))) > 0) {
        ssize_t offset = 0;
        while (offset < count) {
            ssize_t written = write(target, buffer + offset, count - offset);
            if (written <= 0) {
                result = -1;
                break;
            }
            offset += written;
        }
    }
    if (count < 0) {
        result = -1;
    }
    if (source >= 0) {
        close(source);
    }
    if (target >= 0 && close(target)) {
        result = -1;
    }
    if (!result) {
        result = rename(temporary, path);
    }
    if (result) {
        unlink(temporary);
    }
    return result;
}

void *dlopen(const char *path, int flags) {
    void *(*original)(const char *, int) = dlvsym(RTLD_NEXT, "dlopen", "GLIBC_2.2.5");
    const char *replacement = getenv("ZMK_RENODE_TLIB");
    if (path && replacement && strstr(path, "/renode-") &&
        strstr(path, "Antmicro.Renode.translate-arm-m-le.so")) {
        if (replace_library(path, replacement)) {
            fputs("Could not load the prepared Renode CPU backport\n", stderr);
            return NULL;
        }
        const char *log_path = getenv("ZMK_RENODE_CORE_LOG");
        if (log_path) {
            FILE *log = fopen(log_path, "a");
            if (log) {
                fputs("cpu-library-replaced\n", log);
                fclose(log);
            }
        }
    }
    return original(path, flags);
}

void *dlsym(void *handle, const char *name) {
    void *(*original)(void *, const char *) = dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.2.5");
    return original(handle, name);
}

int dlclose(void *handle) {
    int (*original)(void *) = dlvsym(RTLD_NEXT, "dlclose", "GLIBC_2.2.5");
    return original(handle);
}

char *dlerror(void) {
    char *(*original)(void) = dlvsym(RTLD_NEXT, "dlerror", "GLIBC_2.2.5");
    return original();
}
