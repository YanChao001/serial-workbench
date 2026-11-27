#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int x_error;

static int record_error(Display *display, XErrorEvent *event)
{
    (void)display;
    x_error = event->error_code;
    return 0;
}

static int grab(Display *display, KeySym symbol)
{
    KeyCode key = XKeysymToKeycode(display, symbol);
    if (key == 0) {
        return BadValue;
    }
    x_error = 0;
    XGrabKey(display, key, ControlMask | ShiftMask, DefaultRootWindow(display),
             False, GrabModeAsync, GrabModeAsync);
    XSync(display, False);
    return x_error;
}

int main(void)
{
    const char *isolated = getenv("SWB_E2E_X11_GLOBAL_SEND");
    if (isolated == NULL || strcmp(isolated, "1") != 0) {
        fprintf(stderr, "The grab helper requires the isolated X11 suite.\n");
        return EXIT_FAILURE;
    }
    Display *display = XOpenDisplay(NULL);
    if (display == NULL) {
        fprintf(stderr, "Could not open the X11 test display.\n");
        return EXIT_FAILURE;
    }
    XSetErrorHandler(record_error);
    int result = grab(display, XK_F10);
    if (result != 0) {
        fprintf(stderr, "Could not grab Ctrl+Shift+F10 (X11 error %d).\n", result);
        XCloseDisplay(display);
        return EXIT_FAILURE;
    }
    printf("{\"ready\":true,\"pid\":%ld,\"canPost\":false}\n", (long)getpid());
    fflush(stdout);
    char command[64];
    while (fgets(command, sizeof(command), stdin) != NULL) {
        if (strcmp(command, "retained\n") == 0 || strcmp(command, "reclaim\n") == 0) {
            int expected = strcmp(command, "retained\n") == 0 ? BadAccess : 0;
            result = grab(display, XK_F9);
            if (result == expected) {
                puts("{\"ok\":true}");
            } else {
                printf("{\"ok\":false,\"error\":\"Ctrl+Shift+F9 returned X11 error %d, expected %d\"}\n",
                       result, expected);
            }
        } else {
            puts("{\"ok\":false,\"error\":\"Unexpected X11 grab command\"}");
        }
        fflush(stdout);
    }
    XCloseDisplay(display);
    return EXIT_SUCCESS;
}
