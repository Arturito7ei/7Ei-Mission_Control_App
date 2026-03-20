import { View, Text, StyleSheet } from 'react-native'

export default function TasksScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.placeholder}>Task Log — Sprint 3</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a' },
  placeholder: { color: '#555555', fontSize: 16 },
})
