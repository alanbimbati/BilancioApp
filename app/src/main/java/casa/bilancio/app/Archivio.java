package casa.bilancio.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * What the page may do on disk: list, read and write files under the one data folder the user picked,
 * which is the folder Syncthing keeps in step with the PC and the Pi. Paths are relative to it and may not
 * climb out of it.
 */
public class Archivio {

    static final int SCEGLI_CARTELLA = 41;

    private final Activity activity;
    private final SharedPreferences prefs;

    Archivio(Activity activity) {
        this.activity = activity;
        this.prefs = activity.getSharedPreferences("bilancio", Context.MODE_PRIVATE);
    }

    @JavascriptInterface
    public String cartella() {
        return prefs.getString("cartella", "");
    }

    @JavascriptInterface
    public boolean permesso() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    @JavascriptInterface
    public void chiediPermesso() {
        activity.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivity(i);
            } else {
                activity.requestPermissions(new String[]{
                        android.Manifest.permission.READ_EXTERNAL_STORAGE,
                        android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, 1);
            }
        });
    }

    @JavascriptInterface
    public void scegliCartella() {
        activity.runOnUiThread(() ->
                activity.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), SCEGLI_CARTELLA));
    }

    @JavascriptInterface
    public void impostaCartella(String percorso) {
        prefs.edit().putString("cartella", percorso).apply();
    }

    /** The picker answers with a tree URI; the files are then reached by path, which "all files" access allows. */
    static String percorsoDa(Uri albero) {
        String id = DocumentsContract.getTreeDocumentId(albero);
        int due = id.indexOf(':');
        if (due < 0) return null;
        String volume = id.substring(0, due), resto = id.substring(due + 1);
        String radice = "primary".equals(volume)
                ? Environment.getExternalStorageDirectory().getAbsolutePath()
                : "/storage/" + volume;
        return resto.isEmpty() ? radice : radice + "/" + resto;
    }

    private File dentro(String relativo) {
        String base = cartella();
        if (base.isEmpty() || relativo.contains("..")) return null;
        return new File(base, relativo);
    }

    @JavascriptInterface
    public String elenco(String sottocartella) {
        JSONArray out = new JSONArray();
        File dir = dentro(sottocartella);
        File[] figli = dir == null ? null : dir.listFiles();
        if (figli == null) return out.toString();
        try {
            // Folders too: every portfolio is a folder of yearly files.
            for (File f : figli) {
                out.put(new JSONObject().put("nome", f.getName()).put("dir", f.isDirectory())
                        .put("mtime", f.lastModified()).put("size", f.isFile() ? f.length() : 0));
            }
        } catch (Exception ignored) {
            // a JSONException here cannot happen with plain strings and numbers
        }
        return out.toString();
    }

    @JavascriptInterface
    public String leggi(String relativo) {
        File f = dentro(relativo);
        if (f == null || !f.isFile()) return null;
        try {
            return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    /** Returns "" when written, otherwise the error. Written beside the file and renamed over it, so Syncthing never sends half a year. */
    @JavascriptInterface
    public String scrivi(String relativo, String testo) {
        File f = dentro(relativo);
        if (f == null) return "Cartella dati non impostata";
        try {
            File dir = f.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return "Non riesco a creare " + dir;
            File tmp = new File(dir, "." + f.getName() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(testo.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (!tmp.renameTo(f)) return "Non riesco a salvare " + f.getName();
            return "";
        } catch (Exception e) {
            return e.getMessage() == null ? e.toString() : e.getMessage();
        }
    }
}
