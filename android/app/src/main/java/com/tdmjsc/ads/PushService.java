package com.tdmjsc.ads;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.RingtoneManager;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

// Nhận thông báo FCM (máy chủ gửi qua fcm.js). App ở nền: Android tự hiện thông báo theo
// kênh "orders"; app đang mở: Android không tự hiện nên hiện ở đây.
public class PushService extends FirebaseMessagingService {
    static final String CHANNEL = "orders";

    static void createChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Đơn hàng OMS", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Thông báo đơn mới / đơn được giao");
        ch.enableVibration(true);
        c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    @Override public void onNewToken(String token) {
        // Token đổi (cài lại app, xoá dữ liệu...) → lần tải trang tới MainActivity gửi lại lên máy chủ.
        getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit()
                .putString("fcmToken", token).remove("fcmSynced").apply();
    }

    @Override public void onMessageReceived(RemoteMessage msg) {
        RemoteMessage.Notification n = msg.getNotification();
        String title = n != null ? n.getTitle() : msg.getData().get("title");
        String body = n != null ? n.getBody() : msg.getData().get("body");
        if (title == null && body == null) return;
        createChannel(this);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pi);
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(Notification.PRIORITY_HIGH)
                    .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))
                    .setDefaults(Notification.DEFAULT_VIBRATE);
        }
        try {
            getSystemService(NotificationManager.class).notify((int) System.currentTimeMillis(), b.build());
        } catch (SecurityException e) {
            // chưa cho phép thông báo
        }
    }
}
