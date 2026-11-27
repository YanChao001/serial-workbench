/* SPDX-License-Identifier: Apache-2.0 */
#include <gtk/gtk.h>
#include <stdio.h>

static void offer_uris(GtkWidget *widget, GdkDragContext *context,
                       GtkSelectionData *selection, guint info, guint time,
                       gpointer data) {
    (void)widget;
    (void)context;
    (void)info;
    (void)time;
    if (gtk_selection_data_set_uris(selection, data)) {
        puts("file-uris-offered");
        fflush(stdout);
    }
}

static void drag_started(GtkWidget *widget, GdkDragContext *context,
                         gpointer data) {
    (void)widget;
    (void)context;
    (void)data;
    puts("file-drag-started");
    fflush(stdout);
}

static void drag_finished(GtkWidget *widget, GdkDragContext *context,
                          gpointer data) {
    (void)widget;
    (void)context;
    (void)data;
    gtk_main_quit();
}

int main(int argc, char **argv) {
    if (argc < 3 || !gtk_init_check(NULL, NULL)) {
        fputs("Usage on an isolated GTK desktop: x11-file-drag TITLE FILE...\n",
              stderr);
        return 1;
    }

    g_auto(GStrv) uris = g_new0(gchar *, argc - 1);
    for (int i = 2; i < argc; i++) {
        g_autoptr(GError) error = NULL;
        uris[i - 2] = g_filename_to_uri(argv[i], NULL, &error);
        if (!uris[i - 2]) {
            g_printerr("Invalid local file: %s\n", error->message);
            return 1;
        }
    }

    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), argv[1]);
    gtk_window_set_default_size(GTK_WINDOW(window), 180, 72);
    gtk_window_set_decorated(GTK_WINDOW(window), FALSE);
    gtk_window_set_keep_above(GTK_WINDOW(window), TRUE);

    GtkWidget *source = gtk_event_box_new();
    gtk_container_add(GTK_CONTAINER(window), source);
    gtk_container_add(GTK_CONTAINER(source), gtk_label_new("Test file drag"));
    gtk_drag_source_set(source, GDK_BUTTON1_MASK, NULL, 0, GDK_ACTION_COPY);
    gtk_drag_source_add_uri_targets(source);
    g_signal_connect(source, "drag-begin", G_CALLBACK(drag_started), NULL);
    g_signal_connect(source, "drag-data-get", G_CALLBACK(offer_uris), uris);
    g_signal_connect(source, "drag-end", G_CALLBACK(drag_finished), NULL);
    g_signal_connect(window, "destroy", G_CALLBACK(gtk_main_quit), NULL);

    gtk_widget_show_all(window);
    gtk_main();
    return 0;
}
